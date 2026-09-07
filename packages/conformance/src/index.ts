/**
 * @cag/conformance — prove a B20 integration survives corporate actions.
 *
 * Offline and deterministic: no RPC, no database, no clock. That is what lets a customer run
 * these in their own CI and get the same answer the hosted lab gets.
 */

export {
  ADAPTER_CONTRACT_VERSION,
  MUTATIONS,
  mutationById,
  type AdapterAnswer,
  type ConformanceAdapter,
  type MutationId,
} from './adapter.js';

export {
  SCENARIO_IDS,
  SCENARIOS,
  QUESTION_KINDS,
  scenarioById,
  scenarioInputHash,
  type QuestionKind,
  type Scenario,
  type ScenarioExpectation,
  type ScenarioFact,
  type ScenarioId,
} from './scenarios.js';

export {
  CASE_STATUSES,
  runConformance,
  toJUnitReport,
  toJsonReport,
  toSarifReport,
  toSummaryLine,
  verifyMutationKilled,
  type CaseResult,
  type CaseStatus,
  type MutationCheck,
  type RunOptions,
  type RunResult,
} from './runner.js';

export { MUTANT_TARGETS, createReferenceAdapter, type MutantFlags } from './reference.js';
