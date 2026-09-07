/**
 * The conformance suite, and the proof that it has teeth.
 *
 * A suite that only ever sees correct code proves nothing about itself. So there are two
 * assertions here, and both have to hold: the correct reference adapter passes every
 * scenario, and each of the eight mutants — every one a real integration bug someone has
 * shipped — fails the scenario designed to catch it.
 *
 * A mutant that fails *everything* would also be useless, so the last test checks that too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_CONTRACT_VERSION,
  createReferenceAdapter,
  MUTANT_TARGETS,
  MUTATIONS,
  runConformance,
  SCENARIOS,
  scenarioInputHash,
  toJUnitReport,
  toJsonReport,
  toSarifReport,
  toSummaryLine,
  verifyMutationKilled,
  type ScenarioId,
} from '../src/index.js';

const FIXED_NOW = () => '2026-09-07T12:00:00.000Z';

describe('the reference integration is conformant', () => {
  it('passes every scenario', async () => {
    const run = await runConformance({
      adapter: createReferenceAdapter(),
      seed: 'test',
      now: FIXED_NOW,
    });
    const failures = run.cases.filter((c) => c.status !== 'PASS');
    expect(
      failures.map(
        (f) =>
          `${f.scenarioId}: expected ${f.expectedAnswer}, got ${f.observedAnswer ?? '(threw)'}`,
      ),
    ).toEqual([]);
    expect(run.conformant).toBe(true);
    expect(run.passed).toBe(SCENARIOS.length);
  });

  it('reports conformance as a verdict, never a percentage', () => {
    // 14 of 15 means a customer gets one class of corporate action wrong, and a percentage
    // hides which one.
    const line = toSummaryLine({
      adapterName: 'x',
      adapterContractVersion: '1',
      seed: 's',
      startedAt: FIXED_NOW(),
      cases: [],
      passed: 14,
      failed: 1,
      errored: 0,
      conformant: false,
    });
    expect(line).toContain('NOT CONFORMANT');
    expect(line).not.toMatch(/%/);
  });
});

describe('every mutant dies on its target scenario', () => {
  for (const target of MUTANT_TARGETS) {
    it(`${target.mutation} fails ${target.scenarioId}`, async () => {
      const check = await verifyMutationKilled(
        createReferenceAdapter(target.flags, `mutant:${target.mutation}`),
        target.mutation,
        target.scenarioId as ScenarioId,
      );
      expect(check.killed, `${target.mutation} survived ${target.scenarioId}`).toBe(true);
    });
  }

  it('covers every declared mutation', () => {
    // A mutation in the catalogue with no scenario aimed at it is documentation, not a test.
    const targeted = new Set(MUTANT_TARGETS.map((t) => t.mutation));
    expect(MUTATIONS.filter((m) => !targeted.has(m.id)).map((m) => m.id)).toEqual([]);
  });

  it('does not accept a mutant that simply breaks everything', async () => {
    // A mutant failing all 15 scenarios would prove the suite notices *something*, not that
    // it notices the specific defect. The double-multiplier mutant must still pass the
    // scenarios that do not ask for a valuation.
    const run = await runConformance({
      adapter: createReferenceAdapter({ doubleMultiplier: true }, 'mutant:DOUBLE_MULTIPLIER'),
      now: FIXED_NOW,
    });
    expect(run.passed).toBeGreaterThan(SCENARIOS.length / 2);
    expect(run.failed).toBeGreaterThan(0);
  });
});

describe('the failure that matters most', () => {
  it('catches the double multiplier with the exact wrong number', async () => {
    // The concrete failure from the research: after a 10:1 split with a compensated price, a
    // $200 position reads as $2,000. Nothing reverts, and it reconciles against itself.
    const run = await runConformance({
      adapter: createReferenceAdapter({ doubleMultiplier: true }),
      now: FIXED_NOW,
    });
    const split = run.cases.find((c) => c.scenarioId === 'FORWARD_SPLIT_10_TO_1');
    expect(split?.status).toBe('FAIL');
    expect(split?.expectedAnswer).toBe('200.0000000000000000');
    expect(split?.observedAnswer).toBe('2000.0000000000000000');
  });

  it('reports the correct value when the multiplier is applied once', async () => {
    const run = await runConformance({ adapter: createReferenceAdapter(), now: FIXED_NOW });
    const split = run.cases.find((c) => c.scenarioId === 'FORWARD_SPLIT_10_TO_1');
    expect(split?.observedAnswer).toBe('200.0000000000000000');
  });
});

describe('a generic error is not a pass', () => {
  it('fails a case whose answer is right but whose reason is missing', async () => {
    // An adapter that returns the right number with the wrong reason got there by luck, and
    // luck does not survive the next corporate action.
    const lucky = createReferenceAdapter();
    const original = lucky.answer.bind(lucky);
    const stripped = {
      ...lucky,
      answer: async (question: Parameters<typeof original>[0], at: bigint) => {
        const result = await original(question, at);
        return { ...result, reasons: [] };
      },
    };
    const run = await runConformance({ adapter: stripped, now: FIXED_NOW });
    const cancelled = run.cases.find((c) => c.scenarioId === 'SCHEDULE_CANCELLED_BEFORE_EFFECTIVE');
    expect(cancelled?.status).toBe('FAIL');
    expect(cancelled?.observedAnswer).toBe(cancelled?.expectedAnswer);
    expect(cancelled?.missingReasons).toContain('B20_SCHEDULE_CANCELLED');
  });

  it('counts a thrown exception separately from a wrong answer', async () => {
    // "It crashed" and "it confidently returned the wrong number" are different problems.
    const broken = {
      ...createReferenceAdapter(),
      answer: () => {
        throw new Error('adapter exploded');
      },
    };
    const run = await runConformance({ adapter: broken, now: FIXED_NOW });
    expect(run.errored).toBe(SCENARIOS.length);
    expect(run.failed).toBe(0);
    expect(run.conformant).toBe(false);
  });
});

describe('scenario integrity', () => {
  it('gives every scenario a unique id and a stable input hash', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const scenario of SCENARIOS) {
      expect(scenarioInputHash(scenario)).toBe(scenarioInputHash(scenario));
    }
  });

  it('changes the input hash when a scenario is edited', () => {
    // Ties a result to the exact fixture that produced it, so an edited scenario's old
    // results are visibly from a different scenario rather than silently comparable.
    const first = SCENARIOS[0]!;
    const edited = { ...first, evaluateAtSeconds: first.evaluateAtSeconds + 1n };
    expect(scenarioInputHash(edited)).not.toBe(scenarioInputHash(first));
  });

  it('explains what each scenario catches, in terms the integrator recognises', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.catches.length, scenario.id).toBeGreaterThan(40);
      expect(scenario.expectation.rationale.length, scenario.id).toBeGreaterThan(40);
    }
  });

  it('runs entirely offline', () => {
    // No RPC, no database, no clock: the property that lets a customer run this in their CI
    // and get the same answer the hosted lab gets.
    const source = JSON.stringify(SCENARIOS, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(source).not.toMatch(/https?:\/\//);
  });
});

describe('the adapter contract', () => {
  it('carries no number in a value position', () => {
    // A share count that crosses this boundary as a `number` has already lost precision above
    // 2^53, and the suite would then pass an integration whose arithmetic is broken. Asserted
    // against the declared source rather than trusted to review.
    const source = readFileSync(path.join(import.meta.dirname, '../src/adapter.ts'), 'utf8');
    const contract = source.slice(source.indexOf('export interface AdapterAnswer'));
    const fields = [...contract.matchAll(/readonly \w+\??:\s*([^;]+);/g)].map((m) => m[1] ?? '');
    expect(fields.filter((t) => /\bnumber\b/.test(t))).toEqual([]);
  });

  it('is versioned, so a result is meaningful only against a known contract', () => {
    expect(ADAPTER_CONTRACT_VERSION).toMatch(/^\d+$/);
    expect(createReferenceAdapter().contractVersion).toBe(ADAPTER_CONTRACT_VERSION);
  });
});

describe('reports', () => {
  it('produces JSON, JUnit and SARIF from the same result', async () => {
    const run = await runConformance({
      adapter: createReferenceAdapter({ doubleMultiplier: true }),
      now: FIXED_NOW,
    });

    const json = JSON.parse(toJsonReport(run)) as { failed: number };
    expect(json.failed).toBe(run.failed);

    const junit = toJUnitReport(run);
    expect(junit).toContain('<?xml version="1.0"');
    expect(junit).toContain(`failures="${String(run.failed)}"`);
    // The failure message has to say which real bug this is, not just expected/observed.
    expect(junit).toContain('Catches:');

    const sarif = JSON.parse(toSarifReport(run)) as { runs: { results: unknown[] }[] };
    expect(sarif.runs[0]?.results).toHaveLength(run.failed + run.errored);
  });

  it('escapes report content rather than emitting raw adapter text', async () => {
    const hostile = {
      ...createReferenceAdapter(),
      answer: () => ({ answer: '<x>&"', reasons: [], detail: ']]><!--' }),
    };
    const run = await runConformance({ adapter: hostile, now: FIXED_NOW });
    const junit = toJUnitReport(run);
    expect(junit).not.toContain(']]><!--');
    expect(junit).toContain('&lt;');
  });

  it('bounds adapter detail so one case cannot fill a CI log', async () => {
    const chatty = {
      ...createReferenceAdapter(),
      answer: () => ({ answer: 'x', reasons: [], detail: 'y'.repeat(10_000) }),
    };
    const run = await runConformance({ adapter: chatty, now: FIXED_NOW });
    expect(run.cases[0]?.detail?.length).toBeLessThanOrEqual(500);
  });
});
