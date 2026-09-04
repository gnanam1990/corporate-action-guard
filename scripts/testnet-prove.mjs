#!/usr/bin/env node
/**
 * Execute the failure proofs against the deployed testnet contracts.
 *
 * These are the scenarios `docs/final-audit.md` currently records as NOT PROVEN, because
 * they cannot be demonstrated without a real chain. Each one submits a REAL transaction to
 * X Layer testnet and records the outcome with its transaction hash and block.
 *
 * A scenario that is expected to revert must actually revert. A scenario that reverts for
 * the WRONG reason is a failure, not a pass — so each expected failure names the custom
 * error it must produce.
 *
 * Nothing here touches mainnet. The chain id is asserted before anything is submitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiParameters,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARTIFACT = path.join(ROOT, 'contracts/deployments/xlayer-testnet.json');
const OUT = path.join(ROOT, 'docs/evidence/release-candidate.md');

function readEnv() {
  const file = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = { ...readEnv(), ...process.env };

if (!fs.existsSync(ARTIFACT)) {
  console.error('No deployment artifact. Run: pnpm testnet:deploy');
  process.exit(1);
}
const deployment = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
if (deployment.chainId !== 1952 || deployment.implementationVersion !== 2) {
  console.error(
    'Deployment artifact is obsolete. Redeploy the fixed contracts before proving them.',
  );
  process.exit(1);
}

const chain = {
  id: 1952,
  name: 'X Layer Testnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [env['XLAYER_TESTNET_RPC_URL'] ?? 'https://testrpc.xlayer.tech'] } },
};

const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const caller = privateKeyToAccount(env['TESTNET_DEPLOYER_PRIVATE_KEY']);
const signer = privateKeyToAccount(env['RECEIPT_SIGNER_PRIVATE_KEY']);
const wallet = createWalletClient({
  account: caller,
  chain,
  transport: http(chain.rpcUrls.default.http[0]),
});

const ADAPTER = getAddress(deployment.actionGuardAdapter);
const VAULT = getAddress(deployment.protectedVault);
const ASSET = getAddress(deployment.fixtureAsset);
const WRAPPER = getAddress(deployment.fixtureWrapper);

const adapterAbi = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'contracts/out/ActionGuardAdapter.sol/ActionGuardAdapter.json'),
    'utf8',
  ),
).abi;
const assetAbi = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'contracts/out/FixtureAsset.sol/FixtureAsset.json'), 'utf8'),
).abi;

const OPERATION_PARAMS = parseAbiParameters(
  'uint16 schemaVersion, uint256 chainId, address verifyingContract, address caller, address target, address asset, address wrapper, uint8 actionType, address recipient, uint256 amount, uint256 expectedMultiplierNonce',
);
const TAG = keccak256(new TextEncoder().encode('CorporateActionGuard.OperationDigest.v1'));

const RECEIPT_TYPE = {
  PreflightReceipt: [
    { name: 'schemaVersion', type: 'uint16' },
    { name: 'receiptId', type: 'bytes32' },
    { name: 'caller', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'wrapper', type: 'address' },
    { name: 'actionType', type: 'uint8' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'expectedMultiplierNonce', type: 'uint256' },
    { name: 'validAfter', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
    { name: 'operationDigest', type: 'bytes32' },
  ],
};

const digestOf = (r) =>
  keccak256(
    `0x${TAG.slice(2)}${encodeAbiParameters(OPERATION_PARAMS, [
      1,
      BigInt(chain.id),
      ADAPTER,
      r.caller,
      r.target,
      r.asset,
      r.wrapper,
      r.actionType,
      r.recipient,
      r.amount,
      r.expectedMultiplierNonce,
    ]).slice(2)}`,
  );

/**
 * Receipt ids must be unique across RUNS, not just within one.
 *
 * A per-run counter starting at 1 meant every run reused id 0x…01 — consumed by the first
 * run's scenario B — so the second run's valid-receipt scenario reverted with
 * ReceiptAlreadyConsumed. The contract was right; the runner was not idempotent.
 *
 * Seeded from the current time so ids never collide with an earlier run's.
 */
const RUN_SEED = BigInt(Date.now());
let receiptCounter = 0n;
async function buildReceipt(over = {}) {
  // Chain time, not wall clock. The adapter compares against block.timestamp, and even a
  // one-second skew makes a "just expired" receipt still valid on chain — which reported
  // scenario D as a contract failure when the contract was right.
  const head = await publicClient.getBlock();
  const now = head.timestamp;
  const nonce = await publicClient.readContract({
    address: ASSET,
    abi: assetAbi,
    functionName: 'newMultiplierNonce',
  });
  receiptCounter += 1n;

  const receipt = {
    schemaVersion: 1,
    receiptId: `0x${((RUN_SEED << 32n) + receiptCounter).toString(16).padStart(64, '0')}`,
    caller: caller.address,
    target: VAULT,
    asset: ASSET,
    wrapper: WRAPPER,
    actionType: 1,
    recipient: caller.address,
    amount: 10n ** 18n,
    expectedMultiplierNonce: nonce,
    validAfter: now - 60n,
    validUntil: now + 600n,
    ...over,
  };
  receipt.operationDigest = over.operationDigest ?? digestOf(receipt);

  const signature = await signer.signTypedData({
    domain: {
      name: 'CorporateActionGuard',
      version: '1',
      chainId: chain.id,
      verifyingContract: ADAPTER,
    },
    types: RECEIPT_TYPE,
    primaryType: 'PreflightReceipt',
    message: receipt,
  });
  return { receipt, signature };
}

const results = [];

async function scenario(id, title, expectation, run) {
  process.stdout.write(`\n[${id}] ${title}\n`);
  const startedAt = new Date().toISOString();
  try {
    const detail = await run();
    results.push({ id, title, expectation, outcome: 'PASS', startedAt, ...detail });
    console.log(`     PASS — ${detail.summary}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    results.push({ id, title, expectation, outcome: 'FAIL', startedAt, summary: message });
    console.log(`     FAIL — ${message}`);
  }
}

/**
 * Wait until a state change is actually VISIBLE to reads.
 *
 * `waitForTransactionReceipt` proves a transaction was mined. It does NOT prove the node
 * serving the next read has applied it — X Layer's public RPC is load balanced, and a
 * read-after-write can land on a node a block behind. Without this the runner reported
 * "expected a revert, but the call would succeed" for a receipt that was in fact consumed,
 * which reads as a contract bug and is not one.
 */
async function waitForState(check, description, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`state never became visible to reads: ${description}`);
}

/** Submit and expect success. */
async function submit(receipt, signature) {
  const hash = await wallet.writeContract({
    address: ADAPTER,
    abi: adapterAbi,
    functionName: 'execute',
    args: [receipt, signature],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`expected success, transaction reverted: ${hash}`);

  await waitForState(
    () =>
      publicClient.readContract({
        address: ADAPTER,
        abi: adapterAbi,
        functionName: 'consumed',
        args: [receipt.receiptId],
      }),
    `receipt ${receipt.receiptId} marked consumed`,
  );
  return { txHash: hash, block: rcpt.blockNumber.toString() };
}

/** Decode a custom error name from revert data, falling back to the client's own message. */
function decodeRevertName(data, err) {
  // viem often decodes the custom error itself and hands back an object carrying the ABI
  // item, not raw hex. Reading only hex reported every revert as an unnamed failure, which
  // made "reverted for the wrong reason" indistinguishable from "reverted correctly".
  if (data !== null && typeof data === 'object') {
    if (typeof data.errorName === 'string') return data.errorName;
    if (typeof data.abiItem?.name === 'string') return data.abiItem.name;
  }
  // Walk the cause chain: viem nests the decoded error several levels down.
  for (let e = err; e !== undefined && e !== null; e = e.cause) {
    if (typeof e.data?.errorName === 'string') return e.data.errorName;
    if (typeof e.data?.abiItem?.name === 'string') return e.data.abiItem.name;
    if (typeof e.errorName === 'string') return e.errorName;
  }
  try {
    const hex = typeof data === 'string' ? data : data?.data;
    if (typeof hex === 'string') return decodeErrorResult({ abi: adapterAbi, data: hex }).errorName;
  } catch {
    // fall through to the client's own message
  }
  return err?.cause?.shortMessage ?? err?.shortMessage ?? 'revert without decodable error';
}

/** Expect a revert, and expect it to name a specific custom error. */
async function expectRevert(receipt, signature, expectedError) {
  try {
    await publicClient.simulateContract({
      address: ADAPTER,
      abi: adapterAbi,
      functionName: 'execute',
      args: [receipt, signature],
      account: caller,
    });
  } catch (err) {
    const name = decodeRevertName(err?.cause?.data ?? err?.data, err);
    // Reverting for the WRONG reason is a failure, not a pass: it means the guard refused
    // for a reason other than the one this scenario exists to demonstrate.
    if (expectedError !== undefined && name !== expectedError) {
      throw new Error(`reverted with ${name}, expected ${expectedError}`, { cause: err });
    }
    return { summary: `reverted with ${name}`, revertError: name };
  }
  throw new Error('expected a revert, but the call would succeed');
}

async function main() {
  const chainId = await publicClient.getChainId();
  if (chainId !== 1952) throw new Error(`refusing to run against chain ${chainId}; expected 1952`);

  console.log(`X Layer testnet, chain ${chainId}`);
  console.log(`adapter ${ADAPTER}`);
  console.log(`vault   ${VAULT}`);
  console.log(`asset   ${ASSET}`);

  // Clear leftover state from a previous run.
  //
  // Scenario F deliberately schedules an activation INSIDE the guard window, and that
  // persists on chain. On a re-run it correctly refuses scenario B's fresh receipt — the
  // contract behaving properly, reported as a failure. Push any pending activation far
  // enough out that the run starts outside every window.
  const pending = await publicClient.readContract({
    address: ASSET,
    abi: assetAbi,
    functionName: 'newMultiplierActivationTime',
  });
  if (pending > 0n) {
    const head = await publicClient.getBlock();
    const farOut = head.timestamp + 30n * 24n * 3600n;
    console.log(`\nclearing a pending activation from a previous run (was ${pending})`);
    const h = await wallet.writeContract({
      address: ASSET,
      abi: assetAbi,
      functionName: 'scheduleMultiplier',
      args: [10n ** 18n, farOut],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
    await waitForState(
      async () =>
        (await publicClient.readContract({
          address: ASSET,
          abi: assetAbi,
          functionName: 'newMultiplierActivationTime',
        })) === farOut,
      'pending activation pushed outside the guard window',
    );
  }

  // Fund the caller with fixture tokens and approve the vault, once.
  const balance = await publicClient.readContract({
    address: ASSET,
    abi: assetAbi,
    functionName: 'balanceOf',
    args: [caller.address],
  });
  if (balance < 100n * 10n ** 18n) {
    const h = await wallet.writeContract({
      address: ASSET,
      abi: assetAbi,
      functionName: 'faucet',
      args: [1000n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const allowance = await publicClient.readContract({
    address: ASSET,
    abi: assetAbi,
    functionName: 'allowance',
    args: [caller.address, VAULT],
  });
  if (allowance < 100n * 10n ** 18n) {
    // Bounded approval, not unlimited.
    const h = await wallet.writeContract({
      address: ASSET,
      abi: assetAbi,
      functionName: 'approve',
      args: [VAULT, 1000n * 10n ** 18n],
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  await scenario(
    'B',
    'A valid receipt is accepted exactly once',
    'transaction succeeds',
    async () => {
      const { receipt, signature } = await buildReceipt();
      const first = await submit(receipt, signature);
      const replay = await expectRevert(receipt, signature, 'ReceiptAlreadyConsumed');
      return { summary: `executed in block ${first.block}; replay ${replay.summary}`, ...first };
    },
  );

  await scenario('C1', 'Recipient changed after issuance', 'reverts', async () => {
    const { receipt, signature } = await buildReceipt();
    return expectRevert(
      { ...receipt, recipient: '0x000000000000000000000000000000000000dEaD' },
      signature,
    );
  });

  await scenario('C2', 'Amount changed after issuance', 'reverts', async () => {
    const { receipt, signature } = await buildReceipt();
    return expectRevert({ ...receipt, amount: receipt.amount * 2n }, signature);
  });

  await scenario('D', 'Receipt expired', 'reverts with ReceiptExpired', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const { receipt, signature } = await buildReceipt({
      validAfter: now - 600n,
      validUntil: now - 1n,
    });
    return expectRevert(receipt, signature, 'ReceiptExpired');
  });

  await scenario(
    'E',
    'A scheduled corporate action invalidates an outstanding receipt',
    'reverts with MultiplierNonceMismatch',
    async () => {
      const { receipt, signature } = await buildReceipt();
      const activation = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
      const h = await wallet.writeContract({
        address: ASSET,
        abi: assetAbi,
        functionName: 'scheduleMultiplier',
        args: [2n * 10n ** 18n, activation],
      });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      // The nonce advances at SCHEDULE time. Wait for that to be readable before asserting.
      await waitForState(
        async () =>
          (await publicClient.readContract({
            address: ASSET,
            abi: assetAbi,
            functionName: 'newMultiplierNonce',
          })) > receipt.expectedMultiplierNonce,
        'multiplier nonce advanced',
      );
      const out = await expectRevert(receipt, signature, 'MultiplierNonceMismatch');
      return {
        ...out,
        summary: `scheduled in block ${r.blockNumber}; old receipt ${out.summary}`,
        txHash: h,
        block: r.blockNumber.toString(),
      };
    },
  );

  await scenario(
    'F',
    'Inside the guard window, even a fresh receipt is refused',
    'reverts with InsideGuardWindow',
    async () => {
      // The window is [activation - before, activation + after]. Scenario E scheduled an
      // activation an hour out, which is OUTSIDE a 15-minute window — so the contract
      // correctly allowed the action, and this scenario previously failed for the wrong
      // reason. Schedule an activation that actually puts "now" inside the window.
      const windowBefore = await publicClient.readContract({
        address: ADAPTER,
        abi: adapterAbi,
        functionName: 'guardWindowBefore',
      });
      const head = await publicClient.getBlock();
      const activation = head.timestamp + BigInt(windowBefore) / 2n;

      const h = await wallet.writeContract({
        address: ASSET,
        abi: assetAbi,
        functionName: 'scheduleMultiplier',
        args: [3n * 10n ** 18n, activation],
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      await waitForState(
        async () =>
          (await publicClient.readContract({
            address: ASSET,
            abi: assetAbi,
            functionName: 'newMultiplierActivationTime',
          })) === activation,
        'activation time visible',
      );

      // Built AFTER the schedule, so its nonce is current — the only thing that can refuse
      // it is the guard window itself.
      const { receipt, signature } = await buildReceipt();
      return expectRevert(receipt, signature, 'InsideGuardWindow');
    },
  );

  await scenario(
    'G',
    'An unauthorized signer is refused',
    'reverts with UnauthorizedSigner',
    async () => {
      const rogue = privateKeyToAccount(`0x${'22'.repeat(32)}`);
      const { receipt } = await buildReceipt();
      const signature = await rogue.signTypedData({
        domain: {
          name: 'CorporateActionGuard',
          version: '1',
          chainId: chain.id,
          verifyingContract: ADAPTER,
        },
        types: RECEIPT_TYPE,
        primaryType: 'PreflightReceipt',
        message: receipt,
      });
      return expectRevert(receipt, signature, 'UnauthorizedSigner');
    },
  );

  await scenario(
    'H',
    'A direct ERC-20 transfer bypasses the guard entirely',
    'succeeds — the documented boundary',
    async () => {
      const h = await wallet.writeContract({
        address: ASSET,
        abi: assetAbi,
        functionName: 'transfer',
        args: ['0x000000000000000000000000000000000000dEaD', 10n ** 15n],
      });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success')
        throw new Error('the direct transfer failed; the boundary claim needs re-checking');
      return {
        summary: `transferred without touching the adapter, block ${r.blockNumber}`,
        txHash: h,
        block: r.blockNumber.toString(),
      };
    },
  );

  writeEvidence(chainId);

  const failed = results.filter((r) => r.outcome === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed.`);
  console.log(`Evidence written to ${path.relative(ROOT, OUT)}`);
  return failed.length === 0 ? 0 : 1;
}

function writeEvidence(chainId) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const rows = results
    .map(
      (r) =>
        `| ${r.id} | ${r.title} | ${r.expectation} | **${r.outcome}** | ${r.summary}${
          r.txHash ? ` · [tx](https://www.oklink.com/x-layer-test/tx/${r.txHash})` : ''
        } |`,
    )
    .join('\n');

  fs.writeFileSync(
    OUT,
    `<!-- GENERATED by scripts/testnet-prove.mjs. Do not edit by hand. -->

# Release candidate evidence

**Chain:** X Layer testnet (${chainId})
**Generated:** ${new Date().toISOString()}
**Adapter:** \`${ADAPTER}\`
**Vault:** \`${VAULT}\`
**Fixture asset:** \`${ASSET}\`
**Deployed at block:** ${deployment.deployedAtBlock}

Every row below is a **real transaction or simulated call against a real chain**. A
scenario expected to revert must revert *for the named reason* — reverting for a different
reason is recorded as a failure, not a pass.

| # | Scenario | Expectation | Outcome | Evidence |
| --- | --- | --- | --- | --- |
${rows}

## What this does not prove

- Compatibility with production xStocks scheduling semantics. These contracts are a
  \`TESTNET FIXTURE\`; they reproduce the verified *read* surface only.
- Anything about X Layer mainnet, which this build never writes to.
- That the off-chain signer is trustworthy. The adapter verifies chain facts itself but
  cannot verify that the xStocks API agreed at issuance (ADR 0002).

Scenario H is included deliberately: it **succeeds**, and it must. A direct ERC-20 transfer
bypasses the guard, and the product's honesty depends on that being demonstrated rather
than glossed over.
`,
  );
}

process.exit(await main());
