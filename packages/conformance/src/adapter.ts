/**
 * The integration adapter contract.
 *
 * This is the surface a customer implements to run the conformance suite against their own
 * code. It is deliberately small and deliberately *not* our internal API: an adapter that had
 * to speak our types would only prove that our types work.
 *
 * Every quantity crosses this boundary as a string. Not because JSON is nice, but because a
 * quantity that crosses it as a `number` has already lost precision — and a suite that let
 * that through would pass integrations it should fail. `test/runner.test.ts` asserts the
 * declared contract carries no `number` in a value position.
 *
 * Versioned, because a scenario result is only meaningful against a known contract version.
 */

import type { QuestionKind, ScenarioFact } from './scenarios.js';

export const ADAPTER_CONTRACT_VERSION = '1';

/** What the adapter reports back. Outcomes stay a union; never reduced to a boolean. */
export interface AdapterAnswer {
  /**
   * The answer, as an exact string. A share count is raw integer digits; a value is a decimal
   * string; an outcome is its enum name.
   */
  readonly answer: string;
  /**
   * Reason codes the integration attaches. Ours are `B20_*`; an integration may use its own
   * vocabulary and map it, which is why this is `readonly string[]` rather than `B20Reason[]`.
   */
  readonly reasons: readonly string[];
  /** Optional free text shown in the report when a case fails. Never parsed. */
  readonly detail?: string;
}

/**
 * The adapter.
 *
 * `ingest` is called once per fact in order, then exactly one question is asked. An adapter
 * that needs to see all facts before answering can buffer them; one that processes
 * incrementally can act on each. Both are legitimate integration shapes and the suite does
 * not favour either.
 */
export interface ConformanceAdapter {
  readonly name: string;
  readonly contractVersion: string;
  /** Called once before each scenario, so state cannot leak between cases. */
  reset(): void | Promise<void>;
  ingest(fact: ScenarioFact): void | Promise<void>;
  /**
   * Answer the scenario's question at an explicit block timestamp.
   *
   * The timestamp is supplied rather than read from a clock, because a suite whose result
   * depends on when it ran is not a conformance suite.
   */
  answer(question: QuestionKind, evaluateAtSeconds: bigint): AdapterAnswer | Promise<AdapterAnswer>;
}

/*
 * Mutations.
 *
 * A conformance suite with no failing subject proves nothing. Each mutation is a specific,
 * named, real-world integration bug; the suite is only trusted when the correct reference
 * adapter passes a scenario *and* the targeted mutant fails it for the intended reason.
 */

export const MUTATIONS = [
  {
    id: 'RAW_AS_SHARES',
    description: 'Report balanceOf directly as the share count, ignoring the multiplier.',
    realWorldShape:
      'The most common integration bug. Correct until the first corporate action, then wrong ' +
      'by exactly the multiplier, forever.',
  },
  {
    id: 'DOUBLE_MULTIPLIER',
    description: 'Value the share-equivalent quantity with the total-return token price.',
    realWorldShape:
      'Applies the multiplier twice. A $200 position reads as $2,000 after a 10:1 split, and ' +
      'nothing reverts.',
  },
  {
    id: 'ACTIVATE_ON_ARRIVAL',
    description: 'Apply a scheduled multiplier when its event is indexed, not at effectiveAt.',
    realWorldShape:
      'Reads the future. Every holder sees the post-action balance during the window before ' +
      'the action takes effect.',
  },
  {
    id: 'IGNORE_CANCEL',
    description: 'Never process UIMultiplierUpdateCancelled.',
    realWorldShape: 'Applies a corporate action the issuer called off.',
  },
  {
    id: 'KEY_BY_TICKER',
    description: 'Resolve assets by symbol rather than by (chainId, address).',
    realWorldShape: 'Loses the position when the issuer renames the token.',
  },
  {
    id: 'ACCEPT_STALE_FEED',
    description: 'Treat any feed round with a non-zero answer as current.',
    realWorldShape:
      'Values a position against a weekend price, or against the last round before a pause.',
  },
  {
    id: 'DUPLICATE_ON_RETRY',
    description: 'Book both the legacy and the canonical event of one instant update.',
    realWorldShape: 'Applies a corporate action twice.',
  },
  {
    id: 'SWALLOW_REORG',
    description: 'Keep derived state from a block that was reorganized out.',
    realWorldShape:
      'Reports a corporate action that no longer exists on the canonical chain as current.',
  },
] as const;

export type MutationId = (typeof MUTATIONS)[number]['id'];

export function mutationById(id: MutationId): (typeof MUTATIONS)[number] | undefined {
  return MUTATIONS.find((m) => m.id === id);
}
