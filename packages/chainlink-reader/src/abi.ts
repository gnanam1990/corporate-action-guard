/**
 * Chainlink `AggregatorV3Interface`, the subset this product reads.
 *
 * The same interface serves the equity feeds and the L2 sequencer uptime feed, which is why
 * `answer` is `int256` — for a price it is a price, for the uptime feed it is 0 (up) or
 * 1 (down). Reusing one ABI is correct; reusing one *interpretation* would not be, so the
 * semantics live at the call sites and in `freshness.ts`, never here.
 */
export const AGGREGATOR_V3_ABI = [
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
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
] as const;
