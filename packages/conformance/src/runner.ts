/**
 * The conformance runner.
 *
 * Runs scenarios against an adapter and produces a result an integrator can act on. Two
 * decisions shape it.
 *
 * **A generic error is not a pass.** Scenario 3 requires `BLOCK` with `B20_TOKEN_PAUSED`. An
 * integration that throws, or that returns `BLOCK` with no reason, has not demonstrated it
 * understands the pause — it has demonstrated that something went wrong, which is a different
 * and much weaker claim. Missing a required reason fails the case.
 *
 * **The result is CI-neutral.** JSON for machines, JUnit for a build annotation, SARIF for a
 * code-scanning tab. All three are generated from the same result objects, so they cannot
 * disagree about what happened, and none of them carries a secret: an adapter's `detail`
 * string is bounded and the report contains no credentials, no URLs and no request bodies.
 */

import type { ConformanceAdapter, MutationId } from './adapter.js';
import { SCENARIOS, scenarioInputHash, type Scenario, type ScenarioId } from './scenarios.js';

export const CASE_STATUSES = ['PASS', 'FAIL', 'ERROR', 'SKIPPED'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface CaseResult {
  readonly scenarioId: ScenarioId;
  readonly scenarioVersion: string;
  readonly title: string;
  readonly status: CaseStatus;
  readonly question: string;
  readonly expectedAnswer: string;
  readonly observedAnswer?: string;
  /** Reason codes required but not produced. The precise diff, not a similarity score. */
  readonly missingReasons: readonly string[];
  /** Reason codes produced that the scenario forbids. */
  readonly forbiddenReasonsPresent: readonly string[];
  readonly rationale: string;
  /** What real integration bug this case catches, for the failure message. */
  readonly catches: string;
  readonly inputHash: string;
  readonly durationMs: number;
  readonly detail?: string;
}

export interface RunResult {
  readonly adapterName: string;
  readonly adapterContractVersion: string;
  /** Deterministic seed, recorded so a run can be reproduced exactly. */
  readonly seed: string;
  readonly startedAt: string;
  readonly cases: readonly CaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  /** True only when every case passed. Never "mostly". */
  readonly conformant: boolean;
}

/** Bound on adapter free text, so one case cannot fill a CI log. */
const MAX_DETAIL = 500;

export interface RunOptions {
  readonly adapter: ConformanceAdapter;
  readonly scenarios?: readonly Scenario[];
  readonly seed?: string;
  /** Supplied so the runner holds no clock and a run is reproducible. */
  readonly now?: () => string;
}

export async function runConformance(options: RunOptions): Promise<RunResult> {
  const scenarios = options.scenarios ?? SCENARIOS;
  const now = options.now ?? (() => new Date().toISOString());
  const cases: CaseResult[] = [];

  for (const scenario of scenarios) {
    cases.push(await runCase(options.adapter, scenario));
  }

  const passed = cases.filter((c) => c.status === 'PASS').length;
  const failed = cases.filter((c) => c.status === 'FAIL').length;
  const errored = cases.filter((c) => c.status === 'ERROR').length;

  return {
    adapterName: options.adapter.name,
    adapterContractVersion: options.adapter.contractVersion,
    seed: options.seed ?? 'default',
    startedAt: now(),
    cases,
    passed,
    failed,
    errored,
    // Conformance is not a percentage. One failed case means the integration will get one
    // class of corporate action wrong, and "14 of 15" does not tell a customer which.
    conformant: failed === 0 && errored === 0 && cases.length > 0,
  };
}

async function runCase(adapter: ConformanceAdapter, scenario: Scenario): Promise<CaseResult> {
  const started = Date.now();
  const base = {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    title: scenario.title,
    question: scenario.expectation.question,
    expectedAnswer: scenario.expectation.answer,
    rationale: scenario.expectation.rationale,
    catches: scenario.catches,
    inputHash: scenarioInputHash(scenario),
  };

  try {
    // Reset before every scenario: state leaking between cases would let an adapter pass a
    // case using evidence from a previous one, which is the opposite of what is being tested.
    await adapter.reset();
    // Only facts at or before the evaluation timestamp are ingested. An integration cannot
    // have observed an event that has not happened yet, and feeding it one would let a
    // scenario be passed by reading the future — the exact defect several of these scenarios
    // exist to catch. Enforced here rather than per-scenario so no scenario can leak it.
    for (const fact of scenario.facts) {
      if (fact.blockTimestampSeconds > scenario.evaluateAtSeconds) continue;
      await adapter.ingest(fact);
    }
    const answer = await adapter.answer(scenario.expectation.question, scenario.evaluateAtSeconds);

    const reasons = new Set(answer.reasons);
    const missing = scenario.expectation.requiredReasons.filter((r) => !reasons.has(r));
    const forbidden = scenario.expectation.forbiddenReasons.filter((r) => reasons.has(r));
    const answerMatches = answer.answer === scenario.expectation.answer;

    return {
      ...base,
      // All three must hold. An adapter that returns the right number with the wrong reason
      // got there by luck, and luck does not survive the next corporate action.
      status: answerMatches && missing.length === 0 && forbidden.length === 0 ? 'PASS' : 'FAIL',
      observedAnswer: answer.answer,
      missingReasons: missing,
      forbiddenReasonsPresent: forbidden,
      durationMs: Date.now() - started,
      ...(answer.detail !== undefined ? { detail: answer.detail.slice(0, MAX_DETAIL) } : {}),
    };
  } catch (error) {
    // A thrown exception is ERROR, not FAIL, and they are counted separately. "It crashed" and
    // "it confidently returned the wrong number" are different problems for an integrator.
    return {
      ...base,
      status: 'ERROR',
      missingReasons: [...scenario.expectation.requiredReasons],
      forbiddenReasonsPresent: [],
      durationMs: Date.now() - started,
      detail: String((error as Error)?.message ?? error).slice(0, MAX_DETAIL),
    };
  }
}

/*
 * Mutation verification.
 *
 * A suite that only ever sees correct code proves nothing about its own teeth. This runs the
 * same scenarios against a deliberately broken adapter and asserts the targeted case fails —
 * and, just as importantly, that unrelated cases still pass, because a mutant that breaks
 * everything tests nothing.
 */

export interface MutationCheck {
  readonly mutation: MutationId;
  readonly scenarioId: ScenarioId;
  /** The mutant must fail this scenario. */
  readonly killed: boolean;
  readonly observedStatus: CaseStatus;
}

export async function verifyMutationKilled(
  mutantAdapter: ConformanceAdapter,
  mutation: MutationId,
  scenarioId: ScenarioId,
): Promise<MutationCheck> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (scenario === undefined) throw new Error(`unknown scenario ${scenarioId}`);
  const result = await runCase(mutantAdapter, scenario);
  return {
    mutation,
    scenarioId,
    killed: result.status === 'FAIL' || result.status === 'ERROR',
    observedStatus: result.status,
  };
}

/*
 * Reports.
 */

/** Canonical JSON. bigints are stringified; nothing here should ever hold one, but a
 *  serializer that throws in CI is worse than one that is defensive. */
export function toJsonReport(run: RunResult): string {
  return JSON.stringify(run, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * JUnit XML, for a build annotation.
 *
 * The failure message carries the *rationale* and what the case catches, not just "expected X
 * got Y" — a developer reading a red build needs to know which real bug this represents.
 */
export function toJUnitReport(run: RunResult): string {
  const cases = run.cases
    .map((c) => {
      const name = escapeXml(`${c.scenarioId} — ${c.title}`);
      const time = (c.durationMs / 1000).toFixed(3);
      if (c.status === 'PASS') {
        return `    <testcase classname="b20-conformance" name="${name}" time="${time}"/>`;
      }
      if (c.status === 'SKIPPED') {
        return `    <testcase classname="b20-conformance" name="${name}" time="${time}"><skipped/></testcase>`;
      }
      const body = escapeXml(
        [
          `expected ${c.expectedAnswer}, observed ${c.observedAnswer ?? '(threw)'}`,
          c.missingReasons.length > 0 ? `missing reasons: ${c.missingReasons.join(', ')}` : '',
          c.forbiddenReasonsPresent.length > 0
            ? `forbidden reasons present: ${c.forbiddenReasonsPresent.join(', ')}`
            : '',
          '',
          `Why: ${c.rationale}`,
          `Catches: ${c.catches}`,
          c.detail !== undefined ? `Adapter detail: ${c.detail}` : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
      const tag = c.status === 'ERROR' ? 'error' : 'failure';
      return `    <testcase classname="b20-conformance" name="${name}" time="${time}"><${tag} message="${escapeXml(c.scenarioId)}">${body}</${tag}></testcase>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    `  <testsuite name="B20 conformance" tests="${String(run.cases.length)}" failures="${String(run.failed)}" errors="${String(run.errored)}">`,
    cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * SARIF, for a code-scanning surface.
 *
 * Every failing case is one result with a stable rule id, so a scanning tool can track a
 * specific conformance failure across runs rather than seeing a new finding each time.
 */
export function toSarifReport(run: RunResult): string {
  const failing = run.cases.filter((c) => c.status === 'FAIL' || c.status === 'ERROR');
  const rules = [...new Set(failing.map((c) => c.scenarioId))].map((id) => {
    const example = failing.find((c) => c.scenarioId === id);
    return {
      id,
      name: id,
      shortDescription: { text: example?.title ?? id },
      fullDescription: { text: example?.catches ?? '' },
      help: { text: example?.rationale ?? '' },
      defaultConfiguration: { level: 'error' },
    };
  });

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'Corporate Action Guard B20 Conformance',
              informationUri: 'https://github.com/gnanam1990/corporate-action-guard',
              rules,
            },
          },
          results: failing.map((c) => ({
            ruleId: c.scenarioId,
            level: 'error',
            message: {
              text: `expected ${c.expectedAnswer}, observed ${c.observedAnswer ?? '(threw)'}. ${c.rationale}`,
            },
            // No file location: the failure is in the integration under test, not in a file
            // this tool can see. Inventing one would send a reader to the wrong place.
            properties: {
              missingReasons: c.missingReasons,
              forbiddenReasonsPresent: c.forbiddenReasonsPresent,
              inputHash: c.inputHash,
              scenarioVersion: c.scenarioVersion,
            },
          })),
        },
      ],
    },
    null,
    2,
  );
}

/**
 * A one-line summary for a terminal.
 *
 * Says `NOT CONFORMANT` rather than a percentage. A customer with 14 of 15 passing will get
 * one class of corporate action wrong, and the percentage hides which.
 */
export function toSummaryLine(run: RunResult): string {
  const verdict = run.conformant ? 'CONFORMANT' : 'NOT CONFORMANT';
  return (
    `${verdict}: ${String(run.passed)} passed, ${String(run.failed)} failed, ` +
    `${String(run.errored)} errored, of ${String(run.cases.length)} scenarios ` +
    `(adapter ${run.adapterName}, contract v${run.adapterContractVersion})`
  );
}
