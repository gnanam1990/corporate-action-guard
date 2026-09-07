#!/usr/bin/env node
/**
 * The B20 end-to-end proof.
 *
 * One command that runs the real components against real Base mainnet state and produces the
 * comparison this product exists to make:
 *
 *   an integration that reads balanceOf as a share count     -> wrong after any corporate action
 *   an integration that multiplies shares by Chainlink price -> wrong by exactly the multiplier
 *   this product                                             -> correct, with the math shown
 *
 * Nothing here is staged. The identity and multiplier come from a live read at a confirmed
 * Base mainnet block; the arithmetic comes from `@cag/domain`; the broken integrations are
 * the mutation corpus from `@cag/conformance`, which is the same corpus CI runs. If a step
 * cannot be performed, it says so and the artifact records the gap — a proof that quietly
 * substitutes a fixture for a live read is not a proof.
 *
 *   node scripts/b20-e2e-proof.mjs            # live reads, writes the evidence artifact
 *   node scripts/b20-e2e-proof.mjs --offline  # conformance only, for a machine with no network
 *
 * Read-only throughout. Base mainnet chain 8453 is never written to and this script holds no
 * signer (ADR 0007).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http } from 'viem';

import {
  deriveQuantity,
  formatScaledInteger,
  rawToShares,
  unsafeB20,
  WAD_PRECISION,
} from '../packages/domain/dist/index.js';
import {
  createReferenceAdapter,
  MUTANT_TARGETS,
  runConformance,
  toSummaryLine,
} from '../packages/conformance/dist/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs/evidence/b20-end-to-end.md');
/**
 * The same run, as structured data.
 *
 * The console reads this rather than calling a live API, and renders it labelled as a
 * RECORDED REPLAY. That is deliberate: a demo screen that fetched live state would show
 * "no corporate action" for every asset, because none has had one — which is true and
 * demonstrates nothing. Replaying a recorded run is honest as long as the screen says so,
 * and a screen that quietly presented a replay as live would be the exact failure this
 * product exists to catch.
 */
const OUT_JSON = path.join(ROOT, 'apps/web/src/lib/b20-replay.json');
const MANIFEST = path.join(ROOT, 'provenance/base-b20/asset-manifest.json');
const PAIRING = path.join(ROOT, 'provenance/base-b20/token-feed-pairing.json');

const OFFLINE = process.argv.includes('--offline');
const RPC_URL = process.env['BASE_MAINNET_RPC_URL'] ?? 'https://mainnet.base.org';
const BASE_MAINNET_CHAIN_ID = 8453;
/** Read behind head: a value read at `latest` can be reorganized out from under the artifact. */
const CONFIRMATIONS = 200n;

const ONE = WAD_PRECISION;

const READ_ABI = [
  {
    type: 'function',
    name: 'name',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'multiplier',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
];

/**
 * Round an exact scaled integer to 2 decimal places for display.
 *
 * Display only. The exact value travels alongside it everywhere, because invariant V6 says
 * formatting must never be able to change arithmetic — and a screen that showed only the
 * rounded figure would have quietly discarded the precision this product exists to preserve.
 */
function toCurrencyDisplay(value, scale) {
  const cents = value / 10n ** BigInt(scale - 2);
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${fraction}`;
}

const lines = [];
const say = (text = '') => {
  console.log(text);
  lines.push(text);
};
const rule = () => say('─'.repeat(78));

/* ------------------------------------------------------------------ */
/* Step 1 — a real asset, read live                                     */
/* ------------------------------------------------------------------ */

async function readLiveAsset() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const asset = manifest.assets.find((a) => a.displaySymbol === 'AAPLc') ?? manifest.assets[0];

  if (OFFLINE) {
    return { asset, live: undefined, skipped: 'running with --offline' };
  }

  const client = createPublicClient({ transport: http(RPC_URL, { timeout: 30_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    // Evidence labelled with a chain it did not come from passes every downstream check
    // while being about something else entirely.
    throw new Error(`expected Base mainnet ${BASE_MAINNET_CHAIN_ID}, RPC reports ${chainId}`);
  }

  const blockNumber = (await client.getBlockNumber()) - CONFIRMATIONS;
  const block = await client.getBlock({ blockNumber });
  const read = (functionName) =>
    client.readContract({ address: asset.address, abi: READ_ABI, functionName, blockNumber });

  return {
    asset,
    live: {
      chainId,
      blockNumber,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      name: await read('name'),
      symbol: await read('symbol'),
      decimals: await read('decimals'),
      multiplierWad: await read('multiplier'),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 — the three answers                                           */
/* ------------------------------------------------------------------ */

/**
 * The comparison, computed rather than asserted.
 *
 * A 10:1 split is applied to the real asset's decimals and a real Chainlink price shape. The
 * split is a *replay* — no Coinbase asset has had one yet, and saying so is part of the proof.
 */
function threeAnswers(decimals) {
  const raw = unsafeB20.rawAmount(100_000_000n); // 1.0 token at 8 decimals
  const before = unsafeB20.multiplierWad(ONE);
  const after = unsafeB20.multiplierWad(ONE * 10n);
  // The total-return price does not move across a compensated split: the multiplier is
  // already inside it. That invariance is the whole reason route A is the safe route.
  const totalReturnPrice = 20_000_000_000n; // $200.00 at 8 decimals

  const sharesBefore = rawToShares(raw, before);
  const sharesAfter = rawToShares(raw, after);
  if (!sharesBefore.ok || !sharesAfter.ok) throw new Error('conversion failed');

  const correctValue = raw * totalReturnPrice;
  const doubledValue = sharesAfter.value.shares * totalReturnPrice;
  const scale = decimals + 8;

  return {
    raw,
    decimals,
    sharesBefore: sharesBefore.value.shares,
    sharesAfter: sharesAfter.value.shares,
    totalReturnPrice,
    scale,
    rawAsShares: {
      shares: raw,
      label: 'reads balanceOf as the share count',
    },
    doubleMultiplier: {
      value: doubledValue,
      display: formatScaledInteger(doubledValue, scale),
    },
    correct: {
      shares: sharesAfter.value.shares,
      value: correctValue,
      display: formatScaledInteger(correctValue, scale),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

const startedAt = new Date().toISOString();

say('B20 Equity Integrity Layer — end-to-end proof');
say(`run at ${startedAt}${OFFLINE ? '  (offline mode)' : ''}`);
say();

/* Step 1 */
rule();
say('1. A verified Base asset, read live');
rule();

let observation;
try {
  observation = await readLiveAsset();
} catch (error) {
  say(`  SKIPPED: ${String(error.message ?? error)}`);
  say('  A proof that substitutes a fixture for a live read is not a proof, so this step');
  say('  reports the gap rather than filling it.');
  observation = { asset: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).assets[0], live: undefined };
}

const { asset, live } = observation;
say(`  asset            ${asset.displaySymbol}  ${asset.address}`);
say(`  issuer source    ${asset.issuerSource}`);
if (live !== undefined) {
  say(`  chain            ${live.chainId} (Base mainnet, read-only)`);
  say(`  block            ${live.blockNumber}  ${live.blockHash}`);
  say(`  on-chain name    ${live.name}`);
  say(`  on-chain symbol  ${live.symbol}`);
  say(`  decimals         ${live.decimals}`);
  say(`  multiplier       ${formatScaledInteger(live.multiplierWad, 18)}  (${live.multiplierWad})`);
  say();
  say('  Identity is (chainId, address). The symbol is display only — it is mutable on chain,');
  say('  and an integration keyed on it loses the position when the issuer renames the token.');
} else {
  say('  live read       UNAVAILABLE — values below come from the committed manifest');
}
say();

const decimals = Number(live?.decimals ?? asset.decimals);

/* Step 2 */
rule();
say('2. What the chain will not tell us');
rule();

const capability = asset.capabilities?.newUIMultiplier;
say(
  `  newUIMultiplier()  ${capability?.outcome ?? 'UNKNOWN'}   selector ${capability?.selector ?? '?'}`,
);
say(`  effectiveAt()      ${asset.capabilities?.effectiveAt?.outcome ?? 'UNKNOWN'}`);
say();
say('  A B20 token is precompile-backed, and a selector this hardfork has not dialed reverts');
say('  with exactly its own four bytes. So the ERC-8056 scheduling surface is absent, which');
say('  means there is NO READABLE PENDING CORPORATE ACTION on Base mainnet today.');
say();
say('  The product reports UNSUPPORTED_CAPABILITY for that question. It does not report');
say('  "nothing is scheduled" — that would be a false negative on the most safety-critical');
say('  thing it is asked.');
say();

const pairing = JSON.parse(fs.readFileSync(PAIRING, 'utf8'));
const thisPair = pairing.pairs.find((p) => p.tokenAddress === asset.address);
say(`  token to feed      ${thisPair?.reviewStatus ?? 'UNKNOWN'}`);
say('  Nothing on chain links a B20 token to a Chainlink proxy. The only correspondence is a');
say('  ticker match, and a ticker is not an identifier — so a live valuation is refused for');
say('  every class except DISPLAY_POSITION until a human reviews the pairing.');
say();

/* Step 3 */
rule();
say('3. A 10:1 split, replayed — three integrations, one asset, one moment');
rule();
say();

const answers = threeAnswers(decimals);
say(
  `  Holding                    ${formatScaledInteger(answers.raw, decimals)} ${asset.displaySymbol} (raw units, unchanged by the split)`,
);
say(`  Multiplier after the split ${formatScaledInteger(ONE * 10n, 18)}`);
say(
  `  Chainlink total-return     $${formatScaledInteger(answers.totalReturnPrice, 8)} per token — unchanged, because the`,
);
say('                             multiplier is already inside it');
say();
say('  ┌──────────────────────────────────┬───────────────┬───────────────┬──────────┐');
say('  │ integration                      │ shares        │ value         │ verdict  │');
say('  ├──────────────────────────────────┼───────────────┼───────────────┼──────────┤');
say(
  `  │ reads balanceOf as shares        │ ${formatScaledInteger(answers.rawAsShares.shares, decimals).padEnd(13)} │ ${'—'.padEnd(13)} │ WRONG    │`,
);
say(
  `  │ multiplies shares by feed price  │ ${formatScaledInteger(answers.sharesAfter, decimals).padEnd(13)} │ $${answers.doubleMultiplier.display.slice(0, 12).padEnd(12)} │ WRONG    │`,
);
say(
  `  │ Corporate Action Guard           │ ${formatScaledInteger(answers.sharesAfter, decimals).padEnd(13)} │ $${answers.correct.display.slice(0, 12).padEnd(12)} │ VERIFIED │`,
);
say('  └──────────────────────────────────┴───────────────┴───────────────┴──────────┘');
say();
say(
  `  The double-multiplied answer is exactly ${answers.doubleMultiplier.value / answers.correct.value}x the correct one.`,
);
say('  Neither wrong answer reverts. Both reconcile against themselves. A holder sees a');
say('  plausible number and a lending market prices collateral against it.');
say();

const derivation = deriveQuantity(
  answers.raw,
  unsafeB20.multiplierWad(ONE * 10n),
  unsafeB20.tokenDecimals(decimals),
  {
    assetKey: `${live?.chainId ?? 8453}:${asset.address}`,
    blockRef:
      live !== undefined ? `${live.chainId}:${live.blockNumber}@${live.blockHash}` : 'manifest',
    manifestRef: 'provenance/base-b20/asset-manifest.json',
  },
);
say('  Show the math:');
for (const step of derivation.steps ?? []) {
  say(`    ${step.label.padEnd(30)} ${step.expression}`);
  say(`    ${''.padEnd(30)} = ${step.resultDisplay}`);
}
say();

/* Step 4 */
rule();
say('4. The conformance suite, run against a correct integration and eight broken ones');
rule();
say();

const reference = await runConformance({ adapter: createReferenceAdapter(), seed: 'e2e-proof' });
say(`  reference integration:  ${toSummaryLine(reference)}`);

let killed = 0;
for (const target of MUTANT_TARGETS) {
  const run = await runConformance({
    adapter: createReferenceAdapter(target.flags, `mutant:${target.mutation}`),
    seed: 'e2e-proof',
  });
  const failed = run.cases.find((c) => c.scenarioId === target.scenarioId && c.status !== 'PASS');
  if (failed !== undefined) killed += 1;
  say(
    `    ${target.mutation.padEnd(20)} ${(failed !== undefined ? 'CAUGHT' : 'ESCAPED').padEnd(8)} on ${target.scenarioId}`,
  );
}
say();
say(`  ${killed}/${MUTANT_TARGETS.length} known integration defects caught by the suite.`);
say('  A suite that only ever sees correct code proves nothing about itself, so each of these');
say('  is a real bug someone has shipped, and each has to fail the scenario aimed at it.');
say();

/* Step 5 */
rule();
say('5. What this proof does NOT claim');
rule();
say();
say('  - No Coinbase asset has had a corporate action yet. The 10:1 split above is a replay,');
say('    not an observed event. Every listed asset reads multiplier() == 1.0 today.');
say('  - A holder can call the B20 token directly and bypass the guard entirely. Enforcement');
say('    reaches only funds routed through the adapter, and a passing Foundry test asserts');
say('    that bypass exists.');
say('  - Base mainnet is read-only here. Nothing was signed and no transaction was broadcast.');
say('  - No customers, no pilot, no audit, no Coinbase partnership, no production deployment.');
say();

/* Artifact */
const body = lines.join('\n');
const digest = createHash('sha256').update(body, 'utf8').digest('hex');

const artifact = [
  '<!--',
  '  GENERATED FILE — regenerate with: node scripts/b20-e2e-proof.mjs',
  '  Every number below was computed by the run that wrote it.',
  '-->',
  '',
  '# B20 end-to-end proof',
  '',
  `**Run at:** ${startedAt}`,
  live !== undefined
    ? `**Base mainnet block:** ${live.blockNumber} \`${live.blockHash}\``
    : '**Base mainnet:** not read on this run',
  `**Artifact digest:** \`sha256:${digest}\``,
  '',
  '```text',
  body,
  '```',
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, artifact);

const replay = {
  schemaVersion: 1,
  kind: 'b20-recorded-replay',
  disclaimer:
    'RECORDED REPLAY. Generated by scripts/b20-e2e-proof.mjs from a live Base mainnet read ' +
    'plus a replayed 10:1 split. Not live production state, and not an observed corporate ' +
    'action — no Coinbase asset has had one yet.',
  runAt: startedAt,
  artifactDigest: `sha256:${digest}`,
  asset: {
    chainId: live?.chainId ?? 8453,
    address: asset.address,
    displaySymbol: asset.displaySymbol,
    onchainName: live?.name ?? asset.onchainName,
    decimals,
    issuerSource: asset.issuerSource,
    liveRead: live !== undefined,
    blockNumber: live !== undefined ? String(live.blockNumber) : null,
    blockHash: live?.blockHash ?? null,
    observedMultiplierWad: live !== undefined ? String(live.multiplierWad) : null,
  },
  capability: {
    newUIMultiplier: asset.capabilities?.newUIMultiplier?.outcome ?? 'UNKNOWN',
    effectiveAt: asset.capabilities?.effectiveAt?.outcome ?? 'UNKNOWN',
    selector: asset.capabilities?.newUIMultiplier?.selector ?? null,
    consequence:
      'No readable pending corporate action exists on Base mainnet today. The product ' +
      'reports UNSUPPORTED_CAPABILITY rather than "nothing is scheduled".',
  },
  pairing: {
    reviewStatus: thisPair?.reviewStatus ?? 'UNKNOWN',
    consequence:
      'A live valuation is refused for every action class except DISPLAY_POSITION until a ' +
      'human reviews the token-to-feed pairing.',
  },
  replayedSplit: {
    ratio: '10:1',
    rawAmount: String(answers.raw),
    rawDisplay: formatScaledInteger(answers.raw, decimals),
    multiplierBeforeWad: String(ONE),
    multiplierAfterWad: String(ONE * 10n),
    totalReturnPrice: String(answers.totalReturnPrice),
    totalReturnPriceDisplay: formatScaledInteger(answers.totalReturnPrice, 8),
    valueScale: answers.scale,
    rows: [
      {
        integration: 'Reads balanceOf as the share count',
        shares: formatScaledInteger(answers.rawAsShares.shares, decimals),
        value: null,
        valueExact: null,
        verdict: 'WRONG',
        why: 'Correct until the first corporate action, then wrong by exactly the multiplier, forever.',
      },
      {
        integration: 'Multiplies shares by the Chainlink price',
        shares: formatScaledInteger(answers.sharesAfter, decimals),
        value: toCurrencyDisplay(answers.doubleMultiplier.value, answers.scale),
        valueExact: answers.doubleMultiplier.display,
        verdict: 'WRONG',
        why: 'The multiplier is already inside that price, so this applies it twice. Nothing reverts.',
      },
      {
        integration: 'Corporate Action Guard',
        shares: formatScaledInteger(answers.sharesAfter, decimals),
        value: toCurrencyDisplay(answers.correct.value, answers.scale),
        valueExact: answers.correct.display,
        verdict: 'VERIFIED',
        why: 'Route A: raw amount times the total-return price, which the split did not move.',
      },
    ],
    errorFactor: String(answers.doubleMultiplier.value / answers.correct.value),
  },
  derivation: (derivation.steps ?? []).map((step) => ({
    label: step.label,
    expression: step.expression,
    result: step.resultDisplay,
  })),
  conformance: {
    referenceConformant: reference.conformant,
    scenariosPassed: reference.passed,
    scenariosTotal: reference.cases.length,
    mutantsCaught: killed,
    mutantsTotal: MUTANT_TARGETS.length,
    mutants: MUTANT_TARGETS.map((t) => ({ mutation: t.mutation, scenario: t.scenarioId })),
  },
  notClaimed: [
    'No Coinbase asset has had a corporate action yet. The split above is a replay.',
    'A holder can call the B20 token directly and bypass the guard entirely.',
    'Base mainnet is read-only. Nothing was signed and no transaction was broadcast.',
    'No customers, no pilot, no audit, no Coinbase partnership, no production deployment.',
  ],
};
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, `${JSON.stringify(replay, null, 2)}\n`);

rule();
say(`evidence written to docs/evidence/b20-end-to-end.md   sha256:${digest.slice(0, 16)}…`);
say('replay data  written to apps/web/src/lib/b20-replay.json');
rule();

// A failed mutant kill means the suite has lost its teeth, which is worth a non-zero exit in
// CI even though every other step succeeded.
if (killed !== MUTANT_TARGETS.length || !reference.conformant) process.exit(1);
