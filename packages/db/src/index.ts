export { checkDatabase, migrate, MigrationChecksumError, type MigrationResult } from './migrate.js';
export { canonicalize, payloadHash } from './canonical-json.js';
export {
  appendEvidence,
  readAggregate,
  readAllEvents,
  withTransaction,
  type Queryable,
} from './journal.js';
export {
  applyEventToProjections,
  PROJECTION_TABLES,
  rebuildProjections,
  type ProjectionTable,
} from './projections.js';
export {
  EVIDENCE_EVENT_TYPES,
  EVIDENCE_SOURCE_KINDS,
  FORBIDDEN_PAYLOAD_KEYS,
  JournalMutationError,
  type AppendEvidenceInput,
  type AppendResult,
  type ChainProvenance,
  type EvidenceEvent,
  type EvidenceEventType,
  type EvidenceSourceKind,
} from './types.js';
