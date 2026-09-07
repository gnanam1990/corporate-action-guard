/**
 * B20 ABI fragments, transcribed from the pinned snapshot.
 *
 * Every entry here corresponds to a declaration in
 * `provenance/base-b20/base-std/src/interfaces/`, at commit `be6d0450`. Nothing is inferred
 * from a name, a third-party SDK, or an explorer. A test recomputes each selector and topic
 * hash so a transcription slip fails the build rather than decoding garbage at runtime.
 *
 * The fragments are split by *hardfork surface*, because on Base mainnet today only the
 * Beryl half answers. Keeping them apart is what lets the reader refuse to guess at the
 * Cobalt half instead of reporting a false negative.
 */

/** Read selectors that answer on Base mainnet today. Verified live at block 50993686. */
export const BERYL_READ_ABI = [
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
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
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
  {
    type: 'function',
    name: 'WAD_PRECISION',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'toScaledBalance',
    inputs: [{ name: 'rawBalance', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'scaledBalanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isPaused',
    inputs: [{ name: 'feature', type: 'uint8' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'supplyCap',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isAnnouncementIdUsed',
    inputs: [{ name: 'id', type: 'string' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'extraMetadata',
    inputs: [{ name: 'key', type: 'string' }],
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
] as const;

/**
 * The ERC-8056 scheduling surface. **Not dialed on Base mainnet at the recorded block.**
 *
 * Present so the reader can probe for it and use it the moment it activates, and so the
 * capability answer comes from a call rather than from a date.
 */
export const COBALT_READ_ABI = [
  {
    type: 'function',
    name: 'uiMultiplier',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'newUIMultiplier',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'effectiveAt',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'toUIAmount',
    inputs: [{ name: 'rawAmount', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOfUI',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/** `IB20Factory`, at the precompile address in `StdPrecompiles.sol`. */
export const B20_FACTORY_ABI = [
  {
    type: 'function',
    name: 'isB20',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isB20Initialized',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

/**
 * Events, exactly as declared. Indexed-ness matters: it decides which values arrive in
 * topics and which in data, and getting it wrong silently shifts every decoded field.
 *
 * `MultiplierUpdated` is the deprecated legacy topic and `UIMultiplierUpdated` the canonical
 * one. An instant update emits both, which is why the lifecycle reducer folds by transaction
 * and value rather than treating them as two corporate actions.
 */
export const B20_EVENT_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'MultiplierUpdated',
    inputs: [{ name: 'multiplier', type: 'uint256', indexed: false }],
  },
  {
    type: 'event',
    name: 'UIMultiplierUpdated',
    inputs: [
      { name: 'oldMultiplier', type: 'uint256', indexed: false },
      { name: 'newMultiplier', type: 'uint256', indexed: false },
      { name: 'effectiveAtTimestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UIMultiplierUpdateCancelled',
    inputs: [
      { name: 'cancelledMultiplier', type: 'uint256', indexed: false },
      { name: 'cancelledEffectiveAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Announcement',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'id', type: 'string', indexed: false },
      { name: 'description', type: 'string', indexed: false },
      { name: 'uri', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'EndAnnouncement',
    inputs: [{ name: 'id', type: 'string', indexed: false }],
  },
  {
    type: 'event',
    name: 'NameUpdated',
    inputs: [
      { name: 'updater', type: 'address', indexed: true },
      { name: 'newName', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SymbolUpdated',
    inputs: [
      { name: 'updater', type: 'address', indexed: true },
      { name: 'newSymbol', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Paused',
    inputs: [
      { name: 'updater', type: 'address', indexed: true },
      { name: 'features', type: 'uint8[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Unpaused',
    inputs: [
      { name: 'updater', type: 'address', indexed: true },
      { name: 'features', type: 'uint8[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PolicyUpdated',
    inputs: [
      { name: 'policyScope', type: 'bytes32', indexed: true },
      { name: 'oldPolicyId', type: 'uint64', indexed: false },
      { name: 'newPolicyId', type: 'uint64', indexed: false },
    ],
  },
] as const;

/** `PausableFeature` from `IB20.sol`, in declaration order — the enum's numeric values. */
export const PAUSABLE_FEATURES = ['TRANSFER', 'MINT', 'BURN', 'SEIZE'] as const;
export type PausableFeature = (typeof PAUSABLE_FEATURES)[number];

/** Precompile addresses from `StdPrecompiles.sol`, lowercase. */
export const B20_FACTORY_ADDRESS = '0xb20f000000000000000000000000000000000000' as const;
export const POLICY_REGISTRY_ADDRESS = '0x8453000000000000000000000000000000000002' as const;
export const ACTIVATION_REGISTRY_ADDRESS = '0x8453000000000000000000000000000000000001' as const;

/**
 * Selectors of the Cobalt surface, used by the capability probe.
 *
 * The probe compares revert data against these bytes: a selector the hardfork has not dialed
 * reverts with exactly its own four bytes. Hard-coded rather than derived from the ABI on
 * purpose — a probe that depended on the ABI snapshot could not detect that the snapshot had
 * gone stale. A test asserts each equals `keccak256(signature)[0:4]`.
 */
export const COBALT_SELECTORS = {
  uiMultiplier: '0xa60bf13d',
  newUIMultiplier: '0xdc767007',
  effectiveAt: '0x97a4064f',
  toUIAmount: '0x3248d4ff',
  balanceOfUI: '0x437a9958',
  totalSupplyUI: '0x9bea6429',
  supportsInterface: '0x01ffc9a7',
} as const;

export const BERYL_SELECTORS = {
  multiplier: '0x1b3ed722',
  toScaledBalance: '0x04f04c99',
  scaledBalanceOf: '0x1da24f3e',
  isPaused: '0xbc61e733',
} as const;
