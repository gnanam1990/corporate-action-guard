/**
 * @cag/chainlink-reader — feed, sequencer and freshness reads for Base.
 *
 * Read-only. No signer, no wallet client, no transaction API.
 */

export { AGGREGATOR_V3_ABI } from './abi.js';

export {
  ACTION_CLASSES,
  DEFAULT_FRESHNESS_POLICY,
  PRICE_VERDICTS,
  evaluateFreshness,
  type ActionClass,
  type FeedRound,
  type FreshnessInput,
  type FreshnessPolicy,
  type FreshnessResult,
  type PriceVerdict,
  type SequencerStatus,
  type SessionState,
} from './freshness.js';

export {
  BASE_MAINNET_CHAIN_ID,
  ChainlinkReadSession,
  ChainlinkReaderError,
  SEQUENCER_DOWN,
  SEQUENCER_UP,
  assertComparable,
  openChainlinkReadSession,
  toChainlinkError,
  type ChainlinkErrorKind,
  type ChainlinkReadSessionOptions,
  type FeedObservation,
  type FeedOutcome,
  type SequencerObservation,
  type TokenFeedPairing,
} from './reader.js';
