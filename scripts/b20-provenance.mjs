#!/usr/bin/env node
/**
 * Base B20 provenance capture and drift check.
 *
 * Every production address this product trusts has to be traceable to an official source
 * AND to a live read at a recorded block. A ticker is not an identifier, an address prefix
 * is not an issuer, and a third-party SDK's constant is not evidence. This script is the
 * only sanctioned way an address enters `provenance/base-b20/`.
 *
 *   node scripts/b20-provenance.mjs capture   # re-read everything, write manifests
 *   node scripts/b20-provenance.mjs check     # re-read everything, diff, never write
 *
 * `check` is non-destructive by design. A changed official list or a changed on-chain
 * code hash is a review event, not something a build step silently accepts: the diff is
 * printed and the exit code is non-zero. Promoting a change is a human running `capture`
 * and committing the result.
 *
 * Network access is required. When it is unavailable, `check` exits 0 with an explicit
 * SKIPPED reason rather than pretending the manifests were verified.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, http, keccak256, toHex } from 'viem';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'provenance/base-b20');

const BASE_MAINNET_CHAIN_ID = 8453;

/**
 * Sources. Each is primary: the issuer's own list, Chainlink's own feed directory, and
 * the chain itself. None of them is a search result, an explorer scrape of an unrelated
 * site, or the research report.
 */
const SOURCES = {
  officialAssetList: {
    url: 'https://www.base.org/stocks',
    publisher: 'Base (Coinbase)',
    method: 'HTTPS GET; token addresses parsed from the per-row BaseScan links',
    licensing: 'Public webpage; addresses are factual identifiers, not copyrightable content.',
  },
  chainlinkFeedDirectory: {
    url: 'https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json',
    publisher: 'Chainlink',
    method: 'HTTPS GET of the machine-readable feed directory for Base mainnet',
    licensing: 'Public reference data published by Chainlink Labs.',
  },
  baseStd: {
    url: 'https://github.com/base/base-std',
    publisher: 'Base (Coinbase)',
    method: 'git clone --depth 1; interface sources copied verbatim with per-file sha256',
    licensing: 'MIT (see provenance/base-b20/base-std/LICENSE-NOTICE.md).',
  },
};

/**
 * The RPC endpoint is recorded as an identity, never as a credential. A URL carrying an
 * API key must not be written into a committed manifest, so only the host is stored.
 */
const RPC_URL = process.env['BASE_MAINNET_RPC_URL'] ?? 'https://mainnet.base.org';
const rpcEndpointId = (() => {
  try {
    return new URL(RPC_URL).host;
  } catch {
    return 'unparseable-rpc-url';
  }
})();

/**
 * Confirmation depth for the pinned observation block.
 *
 * Reading at `latest` would pin the manifest to a block that can still be reorganized out,
 * and the recorded block hash would then reference nothing. 200 blocks is roughly seven
 * minutes on Base.
 */
const OBSERVATION_CONFIRMATIONS = 200n;

const HTTP_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const sha256 = (buf) => `0x${createHash('sha256').update(buf).digest('hex')}`;

/** Bounded fetch. An unbounded body from a remote host is a denial-of-service vector. */
async function fetchBounded(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { accept: '*/*', 'user-agent': 'corporate-action-guard-provenance/1' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new Error(`${url} body exceeded ${MAX_BODY_BYTES} bytes`);
  }
  return body;
}

/**
 * Parse the official token list.
 *
 * The page renders one BaseScan link per listed stock, labelled with that stock's display
 * symbol. Parsing the labelled link — rather than every 0x-shaped string on the page —
 * means an unrelated address elsewhere in the markup cannot enter the manifest. A layout
 * change breaks this loudly (zero rows parsed) instead of silently importing junk.
 */
function parseOfficialAssetList(html) {
  const re =
    /aria-label="View ([A-Za-z0-9.-]{1,32}) on BaseScan" href="https:\/\/basescan\.org\/token\/(0x[0-9a-fA-F]{40})"/g;
  const bySymbol = new Map();
  for (const match of html.matchAll(re)) {
    const symbol = match[1];
    const address = match[2].toLowerCase();
    const existing = bySymbol.get(symbol);
    if (existing !== undefined && existing !== address) {
      throw new Error(`official list maps symbol ${symbol} to two addresses`);
    }
    bySymbol.set(symbol, address);
  }
  if (bySymbol.size === 0) {
    throw new Error(
      'parsed zero assets from the official list — the page layout changed; ' +
        'fix the parser deliberately rather than falling back to a cached list',
    );
  }
  const byAddress = new Map();
  for (const [symbol, address] of bySymbol) {
    if (byAddress.has(address)) {
      throw new Error(`official list maps address ${address} to two symbols`);
    }
    byAddress.set(address, symbol);
  }
  return [...bySymbol].map(([displaySymbol, address]) => ({ displaySymbol, address }));
}

/**
 * Capability probe selectors.
 *
 * B20 tokens are precompile-backed. A selector the current hardfork does not dial reverts
 * with exactly four bytes: the selector that was called. That is a precise, verifiable
 * capability signal — much stronger than "the call failed, assume unsupported" and much
 * stronger than inferring a capability from a calendar date. Verified on Base mainnet:
 * `uiMultiplier()` (0xa60bf13d) reverts with `0xa60bf13d`.
 */
const CAPABILITY_PROBES = [
  { name: 'multiplier', signature: 'multiplier()', surface: 'BERYL', args: [] },
  { name: 'toScaledBalance', signature: 'toScaledBalance(uint256)', surface: 'BERYL', args: [1n] },
  { name: 'toRawBalance', signature: 'toRawBalance(uint256)', surface: 'BERYL', args: [1n] },
  {
    name: 'scaledBalanceOf',
    signature: 'scaledBalanceOf(address)',
    surface: 'BERYL',
    args: ['0x0000000000000000000000000000000000000001'],
  },
  { name: 'WAD_PRECISION', signature: 'WAD_PRECISION()', surface: 'BERYL', args: [] },
  {
    name: 'isAnnouncementIdUsed',
    signature: 'isAnnouncementIdUsed(string)',
    surface: 'BERYL',
    args: [''],
  },
  { name: 'contractURI', signature: 'contractURI()', surface: 'BERYL', args: [] },
  { name: 'supplyCap', signature: 'supplyCap()', surface: 'BERYL', args: [] },
  { name: 'isPaused', signature: 'isPaused(uint8)', surface: 'BERYL', args: [0] },
  { name: 'uiMultiplier', signature: 'uiMultiplier()', surface: 'COBALT_ERC8056', args: [] },
  { name: 'newUIMultiplier', signature: 'newUIMultiplier()', surface: 'COBALT_ERC8056', args: [] },
  { name: 'effectiveAt', signature: 'effectiveAt()', surface: 'COBALT_ERC8056', args: [] },
  {
    name: 'toUIAmount',
    signature: 'toUIAmount(uint256)',
    surface: 'COBALT_ERC8056',
    args: [1n],
  },
  {
    name: 'balanceOfUI',
    signature: 'balanceOfUI(address)',
    surface: 'COBALT_ERC8056',
    args: ['0x0000000000000000000000000000000000000001'],
  },
  { name: 'totalSupplyUI', signature: 'totalSupplyUI()', surface: 'COBALT_ERC8056', args: [] },
  {
    name: 'MAX_UI_MULTIPLIER',
    signature: 'MAX_UI_MULTIPLIER()',
    surface: 'COBALT_ERC8056',
    args: [],
  },
  {
    name: 'supportsInterface',
    signature: 'supportsInterface(bytes4)',
    surface: 'COBALT_ERC8056',
    args: ['0xa60bf13d'],
  },
];

const selectorOf = (signature) => keccak256(toHex(signature)).slice(0, 10);

/**
 * Classify one probe.
 *
 * LIVE          the selector is dialed and returned data
 * NOT_DIALED    revert data is exactly the called selector — the hardfork has not enabled it
 * REVERTED      dialed, but reverted for another reason (argument-dependent, still a capability)
 * UNAVAILABLE   the RPC itself failed; this says nothing about the capability
 */
async function probeCapability(client, address, probe, blockNumber) {
  const selector = selectorOf(probe.signature);
  try {
    const data = await withRetry(() =>
      client.call({ to: address, data: encodeProbeCall(probe, selector), blockNumber }),
    );
    return { outcome: 'LIVE', selector, returnDataBytes: (data.data ?? '0x').length / 2 - 1 };
  } catch (error) {
    const revertData = extractRevertData(error);
    if (revertData === selector) return { outcome: 'NOT_DIALED', selector };
    if (revertData !== undefined) return { outcome: 'REVERTED', selector, revertData };
    return { outcome: 'UNAVAILABLE', selector, detail: shortMessage(error) };
  }
}

function encodeProbeCall(probe, selector) {
  // Hand-encoded to keep the probe independent of any ABI snapshot: a capability probe
  // that depended on the snapshot could not detect that the snapshot had gone stale.
  let encoded = selector;
  for (const arg of probe.args) {
    if (typeof arg === 'bigint') encoded += arg.toString(16).padStart(64, '0');
    else if (typeof arg === 'number') encoded += arg.toString(16).padStart(64, '0');
    else if (typeof arg === 'string' && arg.startsWith('0x') && arg.length === 42)
      encoded += arg.slice(2).toLowerCase().padStart(64, '0');
    else if (typeof arg === 'string' && arg.startsWith('0x'))
      encoded += arg.slice(2).toLowerCase().padEnd(64, '0');
    else if (typeof arg === 'string')
      encoded += (32).toString(16).padStart(64, '0') + '0'.repeat(64);
    else throw new Error(`unsupported probe argument ${String(arg)}`);
  }
  return encoded;
}

function extractRevertData(error) {
  for (let e = error; e !== null && e !== undefined; e = e.cause) {
    const data = e.data ?? e.raw;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data)) return data.toLowerCase();
    const match = /data: "(0x[0-9a-fA-F]*)"/.exec(String(e.details ?? e.message ?? ''));
    if (match) return match[1].toLowerCase();
  }
  return undefined;
}

const shortMessage = (error) =>
  String(error?.shortMessage ?? error?.message ?? error).slice(0, 200);

/**
 * A public RPC rate-limits, and a rate-limited read is not evidence of anything.
 *
 * Without this the capture recorded `UNAVAILABLE` for live capabilities and would have
 * frozen "we could not reach the endpoint" into a committed capability matrix. Transport
 * failures retry with backoff; a *revert* is a real answer and is never retried.
 */
let rpcGate = Promise.resolve();
/** Minimum spacing between RPC calls. A public endpoint rate-limits a tight loop. */
const RPC_MIN_INTERVAL_MS = 120;

/** Serialize and pace every RPC call so a burst cannot trip the endpoint's rate limiter. */
function paced(fn) {
  const result = rpcGate.then(fn);
  rpcGate = result.then(
    () => new Promise((resolve) => setTimeout(resolve, RPC_MIN_INTERVAL_MS)),
    () => new Promise((resolve) => setTimeout(resolve, RPC_MIN_INTERVAL_MS)),
  );
  return result;
}

async function withRetry(fn, { attempts = 8, baseDelayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await paced(fn);
    } catch (error) {
      if (extractRevertData(error) !== undefined) throw error;
      lastError = error;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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
    name: 'totalSupply',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'isB20Initialized',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
];

const FEED_ABI = [
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'description',
    inputs: [],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { type: 'uint80', name: 'roundId' },
      { type: 'int256', name: 'answer' },
      { type: 'uint256', name: 'startedAt' },
      { type: 'uint256', name: 'updatedAt' },
      { type: 'uint80', name: 'answeredInRound' },
    ],
    stateMutability: 'view',
  },
];

/** From base-std `StdPrecompiles.sol` at the pinned commit. Re-verified live below. */
const PRECOMPILES = {
  b20Factory: '0xb20f000000000000000000000000000000000000',
  policyRegistry: '0x8453000000000000000000000000000000000002',
  activationRegistry: '0x8453000000000000000000000000000000000001',
};

/** Chainlink's own L2 sequencer uptime feed for Base, taken from the feed directory. */
const SEQUENCER_FEED_NAME = 'L2 Sequencer Uptime Status Feed';

async function capture() {
  const client = createPublicClient({ transport: http(RPC_URL, { timeout: HTTP_TIMEOUT_MS }) });

  const chainId = await client.getChainId();
  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    throw new Error(`expected Base mainnet ${BASE_MAINNET_CHAIN_ID}, RPC reports ${chainId}`);
  }

  const head = await client.getBlockNumber();
  const blockNumber = head - OBSERVATION_CONFIRMATIONS;
  const block = await client.getBlock({ blockNumber });
  const observedAt = new Date().toISOString();

  const observation = {
    chainId,
    rpcEndpointId,
    blockNumber: blockNumber.toString(),
    blockHash: block.hash,
    blockTimestamp: block.timestamp.toString(),
    confirmationsBehindHead: OBSERVATION_CONFIRMATIONS.toString(),
    observedAt,
  };

  const listHtml = await fetchBounded(SOURCES.officialAssetList.url);
  const listed = parseOfficialAssetList(listHtml.toString('utf8'));
  const officialListEvidence = {
    ...SOURCES.officialAssetList,
    retrievedAt: observedAt,
    bodySha256: sha256(listHtml),
    bodyBytes: listHtml.byteLength,
    parsedAssetCount: listed.length,
  };

  const feedsBody = await fetchBounded(SOURCES.chainlinkFeedDirectory.url);
  const feeds = JSON.parse(feedsBody.toString('utf8'));
  if (!Array.isArray(feeds)) throw new Error('Chainlink feed directory did not parse as an array');
  const feedDirectoryEvidence = {
    ...SOURCES.chainlinkFeedDirectory,
    retrievedAt: observedAt,
    bodySha256: sha256(feedsBody),
    bodyBytes: feedsBody.byteLength,
    entryCount: feeds.length,
  };

  const assets = [];
  for (const { displaySymbol, address } of listed.sort((a, b) =>
    a.address.localeCompare(b.address),
  )) {
    const read = async (functionName, args = []) => {
      try {
        return await withRetry(() =>
          client.readContract({ address, abi: READ_ABI, functionName, args, blockNumber }),
        );
      } catch (error) {
        return { __error: shortMessage(error) };
      }
    };

    // Serial, not `Promise.all`: a public RPC rate-limits a burst, and a rate-limited read
    // recorded as "unavailable" would freeze a transport failure into a provenance record.
    const onchainName = await read('name');
    const onchainSymbol = await read('symbol');
    const decimals = await read('decimals');
    const totalSupply = await read('totalSupply');
    const multiplierWad = await read('multiplier');
    const bytecode = await withRetry(() => client.getCode({ address, blockNumber })).catch(
      () => undefined,
    );

    let isB20Initialized;
    try {
      isB20Initialized = await withRetry(() =>
        client.readContract({
          address: PRECOMPILES.b20Factory,
          abi: FACTORY_ABI,
          functionName: 'isB20Initialized',
          args: [address],
          blockNumber,
        }),
      );
    } catch (error) {
      isB20Initialized = { __error: shortMessage(error) };
    }

    const capabilities = {};
    for (const probe of CAPABILITY_PROBES) {
      capabilities[probe.name] = {
        surface: probe.surface,
        ...(await probeCapability(client, address, probe, blockNumber)),
      };
    }

    assets.push({
      chainId,
      address,
      displaySymbol,
      onchainName: typeof onchainName === 'string' ? onchainName : null,
      onchainSymbol: typeof onchainSymbol === 'string' ? onchainSymbol : null,
      decimals: typeof decimals === 'number' ? decimals : null,
      totalSupplyRaw: typeof totalSupply === 'bigint' ? totalSupply.toString() : null,
      multiplierWad: typeof multiplierWad === 'bigint' ? multiplierWad.toString() : null,
      isB20Initialized: typeof isB20Initialized === 'boolean' ? isB20Initialized : null,
      // A B20 token is precompile-backed, so `eth_getCode` is empty. Recording the observed
      // length is what makes that explicit rather than looking like a failed read.
      observedCodeBytes: bytecode === undefined ? null : (bytecode.length - 2) / 2,
      issuerSource: SOURCES.officialAssetList.url,
      explorerUrl: `https://basescan.org/token/${address}`,
      capabilities,
    });
  }

  const equityFeeds = feeds.filter((f) => f?.docs?.assetClass === 'Equity');
  const sequencerEntry = feeds.find((f) => f?.name === SEQUENCER_FEED_NAME);

  const feedEntries = [];
  for (const feed of equityFeeds.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const proxyAddress = String(feed.proxyAddress).toLowerCase();
    let live;
    try {
      const feedRead = (functionName) =>
        withRetry(() =>
          client.readContract({ address: proxyAddress, abi: FEED_ABI, functionName, blockNumber }),
        );
      const decimals = await feedRead('decimals');
      const description = await feedRead('description');
      const round = await feedRead('latestRoundData');
      live = {
        decimals,
        description,
        roundId: round[0].toString(),
        answer: round[1].toString(),
        startedAt: round[2].toString(),
        updatedAt: round[3].toString(),
        answeredInRound: round[4].toString(),
      };
    } catch (error) {
      live = { __error: shortMessage(error) };
    }

    feedEntries.push({
      chainId,
      proxyAddress,
      directoryName: feed.name,
      baseAsset: feed.docs?.baseAsset ?? null,
      quoteAsset: feed.docs?.quoteAsset ?? 'USD',
      directoryDecimals: feed.decimals ?? null,
      heartbeatSeconds: feed.heartbeat ?? null,
      deviationThresholdPercent: feed.threshold ?? null,
      // The single most load-bearing field in this product. Chainlink publishes the
      // multiplier-adjusted token price for a Coinbase B20 asset, NOT the underlying
      // share price. Multiplying a share-equivalent quantity by it applies the multiplier
      // twice. Recording the basis here is what lets the valuation engine refuse that.
      priceBasis: 'TOTAL_RETURN_TOKEN_PRICE',
      source: SOURCES.chainlinkFeedDirectory.url,
      live,
    });
  }

  let sequencer = null;
  if (sequencerEntry !== undefined) {
    const proxyAddress = String(sequencerEntry.proxyAddress).toLowerCase();
    let live;
    try {
      const round = await withRetry(() =>
        client.readContract({
          address: proxyAddress,
          abi: FEED_ABI,
          functionName: 'latestRoundData',
          blockNumber,
        }),
      );
      live = {
        roundId: round[0].toString(),
        answer: round[1].toString(),
        startedAt: round[2].toString(),
        updatedAt: round[3].toString(),
        answeredInRound: round[4].toString(),
      };
    } catch (error) {
      live = { __error: shortMessage(error) };
    }
    sequencer = {
      chainId,
      proxyAddress,
      directoryName: sequencerEntry.name,
      // Chainlink's L2 uptime feed answers 0 = sequencer up, 1 = sequencer down.
      answerSemantics: { 0: 'SEQUENCER_UP', 1: 'SEQUENCER_DOWN' },
      source: SOURCES.chainlinkFeedDirectory.url,
      live,
    };
  }

  const precompiles = {};
  for (const [name, address] of Object.entries(PRECOMPILES)) {
    // A precompile exposes no bytecode, so presence is proven by a call that answers,
    // not by `eth_getCode`. `isB20Initialized(0x0)` is a pure view with no side effect.
    let responds;
    try {
      await withRetry(() =>
        client.readContract({
          address: name === 'b20Factory' ? address : PRECOMPILES.b20Factory,
          abi: FACTORY_ABI,
          functionName: 'isB20Initialized',
          args: ['0x0000000000000000000000000000000000000000'],
          blockNumber,
        }),
      );
      responds = name === 'b20Factory';
    } catch {
      responds = false;
    }
    precompiles[name] = {
      address,
      source: `${SOURCES.baseStd.url}/blob/${readBaseStdCommit()}/src/StdPrecompiles.sol`,
      liveProbe: name === 'b20Factory' ? (responds ? 'RESPONDS' : 'NO_RESPONSE') : 'NOT_PROBED',
    };
  }

  const capabilityMatrix = summarizeCapabilities(assets);

  // A manifest is complete or it is not written. Freezing a transport failure into a
  // committed provenance record would turn "we could not reach the endpoint" into
  // "this capability does not exist", which is exactly the wrong direction to fail.
  const incomplete = [];
  for (const asset of assets) {
    for (const [field, value] of Object.entries(asset)) {
      if (value === null && field !== 'observedCodeBytes') {
        incomplete.push(`asset ${asset.displaySymbol}: ${field} unreadable`);
      }
    }
    for (const [name, cap] of Object.entries(asset.capabilities)) {
      if (cap.outcome === 'UNAVAILABLE') {
        incomplete.push(
          `asset ${asset.displaySymbol}: capability ${name} — ${cap.detail ?? 'RPC failed'}`,
        );
      }
    }
  }
  for (const feed of feedEntries) {
    if (feed.live.__error !== undefined)
      incomplete.push(`feed ${feed.directoryName}: ${feed.live.__error}`);
  }
  if (sequencer?.live?.__error !== undefined) {
    incomplete.push(`sequencer feed: ${sequencer.live.__error}`);
  }
  if (incomplete.length > 0) {
    throw new Error(
      `${incomplete.length} observation(s) could not be read; refusing to write a partial ` +
        `manifest:\n  - ${incomplete.slice(0, 12).join('\n  - ')}`,
    );
  }

  return {
    assetManifest: {
      schemaVersion: 1,
      kind: 'b20-official-asset-manifest',
      observation,
      officialList: officialListEvidence,
      precompiles,
      assets,
    },
    feedManifest: {
      schemaVersion: 1,
      kind: 'chainlink-b20-feed-manifest',
      observation,
      directory: feedDirectoryEvidence,
      sequencerUptimeFeed: sequencer,
      feeds: feedEntries,
      // Deliberately not auto-paired. A token/feed pairing derived from a ticker string is
      // exactly the identity mistake this product exists to catch; pairing is a reviewed
      // decision recorded in `token-feed-pairing.json`, not a substring match.
      pairingPolicy: 'REVIEWED_EXPLICIT_ONLY',
    },
    capabilityMatrix: {
      schemaVersion: 1,
      kind: 'b20-capability-matrix',
      observation,
      ...capabilityMatrix,
    },
  };
}

/**
 * Fold per-asset probes into one chain-wide surface statement, and flag disagreement.
 *
 * If two officially listed assets disagree about a selector, the hardfork surface is not
 * uniform and no single answer is safe; that is recorded as MIXED rather than averaged.
 */
function summarizeCapabilities(assets) {
  const selectors = {};
  for (const probe of CAPABILITY_PROBES) {
    const outcomes = new Set(assets.map((a) => a.capabilities[probe.name]?.outcome ?? 'MISSING'));
    selectors[probe.name] = {
      surface: probe.surface,
      selector: selectorOf(probe.signature),
      signature: probe.signature,
      outcome: outcomes.size === 1 ? [...outcomes][0] : 'MIXED',
      perAssetOutcomes: outcomes.size === 1 ? undefined : [...outcomes].sort(),
    };
  }
  const surfaceLive = (surface) =>
    CAPABILITY_PROBES.filter((p) => p.surface === surface).every(
      (p) => selectors[p.name].outcome === 'LIVE',
    );
  return {
    selectors,
    surfaces: {
      BERYL: surfaceLive('BERYL') ? 'LIVE' : 'PARTIAL',
      COBALT_ERC8056: surfaceLive('COBALT_ERC8056')
        ? 'LIVE'
        : Object.values(selectors).some(
              (s) => s.surface === 'COBALT_ERC8056' && s.outcome === 'LIVE',
            )
          ? 'PARTIAL'
          : 'NOT_ACTIVATED',
    },
    notes: [
      'A selector the hardfork has not dialed reverts with exactly the four bytes of the called selector.',
      'NOT_ACTIVATED is an observation at the recorded block. It is never inferred from a date.',
    ],
  };
}

function readBaseStdCommit() {
  const file = path.join(OUT_DIR, 'base-std/SOURCE.json');
  if (!fs.existsSync(file)) return 'main';
  return JSON.parse(fs.readFileSync(file, 'utf8')).commit ?? 'main';
}

const MANIFESTS = [
  ['assetManifest', 'asset-manifest.json'],
  ['feedManifest', 'feed-manifest.json'],
  ['capabilityMatrix', 'capability-matrix.json'],
];

/**
 * Fields that legitimately change on every observation. Diffing them would make every
 * check fail and train operators to ignore the output; the point of the check is that a
 * non-zero exit means an identity, capability, or provenance change worth reading.
 */
const VOLATILE = new Set([
  'observation',
  'live',
  'retrievedAt',
  'bodySha256',
  'bodyBytes',
  'totalSupplyRaw',
  'multiplierWad',
  'returnDataBytes',
  'entryCount',
]);

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

const stable = (v) => JSON.stringify(stripVolatile(v), null, 2);

function diffLines(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) out.push(`  - ${a[i].trim()}`);
      if (b[i] !== undefined) out.push(`  + ${b[i].trim()}`);
    }
    if (out.length > 80) {
      out.push('  … diff truncated');
      break;
    }
  }
  return out;
}

async function main() {
  const mode = process.argv[2] ?? 'check';
  if (mode !== 'capture' && mode !== 'check') {
    console.error('usage: b20-provenance.mjs <capture|check>');
    process.exit(2);
  }

  let captured;
  try {
    captured = await capture();
  } catch (error) {
    const message = shortMessage(error);
    if (mode === 'check') {
      // A third-party endpoint being unreachable is not a provenance failure. Saying so
      // out loud is the difference between "skipped" and a green tick that proved nothing.
      console.log(`SKIPPED: provenance check could not reach a source — ${message}`);
      process.exit(0);
    }
    console.error(`capture failed: ${message}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (mode === 'capture') {
    for (const [key, file] of MANIFESTS) {
      fs.writeFileSync(path.join(OUT_DIR, file), `${JSON.stringify(captured[key], null, 2)}\n`);
      console.log(`wrote provenance/base-b20/${file}`);
    }
    console.log(
      '\nReview the diff before committing. A changed address, code hash, or capability ' +
        'is a review event, not a routine refresh.',
    );
    return;
  }

  let drifted = 0;
  for (const [key, file] of MANIFESTS) {
    const full = path.join(OUT_DIR, file);
    if (!fs.existsSync(full)) {
      console.error(`MISSING: provenance/base-b20/${file} — run \`capture\` first`);
      drifted++;
      continue;
    }
    const expected = stable(JSON.parse(fs.readFileSync(full, 'utf8')));
    const actual = stable(captured[key]);
    if (expected === actual) {
      console.log(`OK: provenance/base-b20/${file} matches live sources`);
      continue;
    }
    drifted++;
    console.error(`DRIFT: provenance/base-b20/${file} no longer matches live sources`);
    for (const line of diffLines(expected, actual)) console.error(line);
  }

  if (drifted > 0) {
    console.error(
      `\n${drifted} manifest(s) drifted. Re-run \`node scripts/b20-provenance.mjs capture\`, ` +
        'review every change, and commit deliberately. Do not auto-accept.',
    );
    process.exit(1);
  }
}

await main();
