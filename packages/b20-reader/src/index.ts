/**
 * @cag/b20-reader — read-only Base RPC reads and reorg-aware B20 indexing.
 *
 * This package exports no signer, no wallet client, and no way to send a transaction. That
 * absence is the point (ADR 0007), and `test/no-write-surface.test.ts` asserts it.
 */

export {
  B20_EVENT_ABI,
  B20_FACTORY_ABI,
  B20_FACTORY_ADDRESS,
  ACTIVATION_REGISTRY_ADDRESS,
  BERYL_READ_ABI,
  BERYL_SELECTORS,
  COBALT_READ_ABI,
  COBALT_SELECTORS,
  PAUSABLE_FEATURES,
  POLICY_REGISTRY_ADDRESS,
  type PausableFeature,
} from './abi.js';

export {
  B20ReaderError,
  NotDialedError,
  WrongChainError,
  type B20ReaderErrorKind,
} from './errors.js';

export {
  advanceCursor,
  classifyProviderError,
  dedupeLogs,
  detectReorg,
  logIdentity,
  nextRange,
  orderLogs,
  planRanges,
  rewindCursor,
  safeHead,
  shrinkRange,
  type BlockRange,
  type BlockRef,
  type IndexerCursor,
  type RawLog,
  type ReorgOutcome,
} from './indexing.js';

export {
  B20ReadSession,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  CAPABILITY_OUTCOMES,
  classifyProbe,
  extractRevertData,
  openB20ReadSession,
  summarizeCapabilities,
  toReaderError,
  type B20AssetState,
  type B20Capabilities,
  type B20ReadSessionOptions,
  type B20ScheduledUpdate,
  type CapabilityOutcome,
  type CapabilityProbe,
  type ObservationContext,
  type ReadOutcome,
} from './reader.js';
