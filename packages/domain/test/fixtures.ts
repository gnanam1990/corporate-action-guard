import {
  EXACT_TOLERANCE,
  instant,
  millis,
  summarizeCanonicality,
  unsafe,
  type CanonicalityCheck,
  type ChainId,
  type PreflightInput,
  type SourceComparison,
} from '../src/index.js';

export const TOKEN = unsafe.address('0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a');
export const WRAPPER = unsafe.address('0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f');
export const VAULT = unsafe.address('0x1111111111111111111111111111111111111111');
export const RECIPIENT = unsafe.address('0x2222222222222222222222222222222222222222');
export const TESTNET: ChainId = unsafe.chainId(1952);

export const NOW = instant(1_760_000_000_000);

const allPass: CanonicalityCheck[] = [
  { name: 'TOKEN_MATCHES_REGISTRY', outcome: 'PASS', detail: 'matches registry' },
  { name: 'WRAPPER_MATCHES_REGISTRY', outcome: 'PASS', detail: 'matches registry' },
  { name: 'TOKEN_HAS_BYTECODE', outcome: 'PASS', detail: 'code present at observed block' },
  { name: 'WRAPPER_HAS_BYTECODE', outcome: 'PASS', detail: 'code present at observed block' },
  {
    name: 'WRAPPER_ASSET_RELATION',
    outcome: 'PASS',
    detail: 'wrapper.asset() equals expected token',
  },
  { name: 'WRAPPER_VERSION_CURRENT', outcome: 'PASS', detail: 'wrapper is the current version' },
];

export const MATCHING_SOURCES: SourceComparison = {
  agreement: 'MATCH',
  fields: [
    { field: 'multiplier', agreement: 'MATCH', apiValue: '1.0', chainValue: '1.0' },
    { field: 'multiplierNonce', agreement: 'MATCH', apiValue: '7', chainValue: '7' },
    {
      field: 'scheduledActivation',
      agreement: 'MATCH',
      apiValue: undefined,
      chainValue: undefined,
    },
    { field: 'wrapperAddress', agreement: 'MATCH', apiValue: WRAPPER, chainValue: WRAPPER },
  ],
};

/**
 * The single input that produces ALLOW. Every negative test starts here and breaks exactly
 * one thing, so a test can never pass because two faults cancelled out.
 */
export function allowingInput(): PreflightInput {
  return {
    action: {
      chainId: TESTNET,
      target: VAULT,
      assetAddress: TOKEN,
      wrapperAddress: WRAPPER,
      actionType: 'DEPOSIT',
      recipient: RECIPIENT,
      amount: 1_000_000n,
      expectedMultiplierNonce: 7n,
    },
    supportedChainIds: [TESTNET],
    supportedTargets: [VAULT],
    supportedActionTypes: ['DEPOSIT', 'WITHDRAW'],
    evidenceChainId: TESTNET,
    assetKnown: true,
    registryTokenAddress: TOKEN,
    registryWrapperAddress: WRAPPER,
    registryWrapperIsCurrent: true,
    observedWrapperAsset: TOKEN,
    canonicality: summarizeCanonicality(allPass),
    sourceComparison: MATCHING_SOURCES,
    onChainMultiplierNonce: 7n,
    guardBefore: millis(15 * 60_000),
    guardAfter: millis(15 * 60_000),
    apiObservedAt: instant(NOW - 5_000),
    chainObservedAt: instant(NOW - 5_000),
    freshness: { apiMaxAge: millis(60_000), chainMaxAge: millis(60_000) },
    manualReviewOpen: false,
  };
}

export { EXACT_TOLERANCE };
