/**
 * Verified ABI fragments.
 *
 * **Every entry here was confirmed by a live `eth_call` against X Layer mainnet on
 * 2026-09-03**, not copied from a planning document. Selectors that reverted are recorded
 * as unsupported rather than guessed — inventing an ABI signature produces a decoded value
 * that looks authoritative and is meaningless.
 *
 * The single most important finding: **the multiplier lives on the TOKEN, not the
 * wrapper.** Calling `getCurrentMultiplier()` on the wrapper reverts. The wrapper exposes
 * only the ERC-4626-style conversion surface and `asset()`.
 */

/** Confirmed on the token, e.g. AAPLx at 0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a. */
export const CORPORATE_ACTION_TOKEN_ABI = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  // --- Corporate action surface, all verified live ---
  {
    type: 'function',
    name: 'getCurrentMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'multiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplierNonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'newMultiplierActivationTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Confirmed on the wrapper, e.g. wAAPLx at 0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f. */
export const WRAPPER_ABI = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  /** Returns the underlying xStock. This is the wrapper-to-asset relation the guard checks. */
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToShares',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Events confirmed to be emitted by the token on mainnet.
 *
 * `TransferShares` was observed on chain and resolved through the public signature
 * directory against a verified contract. `Transfer` is the ERC-20 standard.
 */
export const CONFIRMED_TOKEN_EVENTS = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TransferShares',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * Capabilities this product needs but could NOT verify on mainnet.
 *
 * No corporate action occurred in the observable log window, so no schedule or override
 * event was available to confirm, and the X Layer explorer does not serve a verified ABI
 * without an API key. Rather than invent a signature, log-based schedule detection is
 * reported as unsupported on mainnet.
 *
 * This costs the product nothing on the safety path: `newMultiplierNonce()` and
 * `newMultiplierActivationTime()` are verified reads that give the schedule state
 * directly, and polling them is authoritative. Events would only make detection cheaper,
 * not more correct.
 *
 * The testnet fixture defines its own schedule and override events with signatures known
 * from its own source, so event-driven replay is still proven end to end.
 */
export const UNVERIFIED_MAINNET_CAPABILITIES = [
  'MULTIPLIER_SCHEDULED_EVENT',
  'MULTIPLIER_OVERRIDDEN_EVENT',
  'MULTIPLIER_EFFECTIVE_EVENT',
] as const;

export type UnverifiedCapability = (typeof UNVERIFIED_MAINNET_CAPABILITIES)[number];
