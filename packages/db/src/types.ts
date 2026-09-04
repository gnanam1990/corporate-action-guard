/** Event types the journal accepts. Mirrors the `evidence_event_type` enum in SQL. */
export const EVIDENCE_EVENT_TYPES = [
  'ASSET_DISCOVERED',
  'API_SNAPSHOT_OBSERVED',
  'CHAIN_SNAPSHOT_OBSERVED',
  'MULTIPLIER_SCHEDULED',
  'MULTIPLIER_OVERRIDDEN',
  'GUARD_WINDOW_ENTERED',
  'MULTIPLIER_EFFECTIVE',
  'RECONCILIATION_MATCHED',
  'RECONCILIATION_MISMATCHED',
  'MANUAL_REVIEW_OPENED',
  'MANUAL_REVIEW_RESOLVED',
  'RECEIPT_ISSUED',
  'RECEIPT_CONSUMED',
  'ACTION_REJECTED',
  'ACTION_EXECUTED',
  'SOURCE_DEGRADED',
  'SOURCE_RECOVERED',
  'REORG_DETECTED',
  'CHAIN_CURSOR_ADVANCED',
  'CHAIN_EVENTS_REVERTED',
  'PROJECTION_REBUILT',
] as const;

export type EvidenceEventType = (typeof EVIDENCE_EVENT_TYPES)[number];

export const EVIDENCE_SOURCE_KINDS = [
  'XSTOCKS_API',
  'FIXTURE_CONTROL_PLANE',
  'XLAYER_RPC',
  'OPERATOR',
  'SYSTEM',
] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export interface ChainProvenance {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly txHash?: string;
  readonly logIndex?: number;
}

export interface AppendEvidenceInput {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: EvidenceEventType;
  readonly eventVersion?: number;
  /** When this process observed the fact. UTC. */
  readonly observedAt: Date;
  /** When the source says it was true. Omitted when the source does not say. */
  readonly sourceTime?: Date;
  readonly chain?: ChainProvenance;
  readonly sourceKind: EvidenceSourceKind;
  /** Endpoint path or provider identifier. Must never contain credentials. */
  readonly sourceLocator: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly producerVersion: string;
}

export interface EvidenceEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: EvidenceEventType;
  readonly eventVersion: number;
  readonly observedAt: Date;
  readonly sourceTime: Date | null;
  readonly ingestedAt: Date;
  readonly chainId: number | null;
  readonly blockNumber: bigint | null;
  readonly blockHash: string | null;
  readonly txHash: string | null;
  readonly logIndex: number | null;
  readonly sourceKind: EvidenceSourceKind;
  readonly sourceLocator: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly producerVersion: string;
}

/** Outcome of an append. A duplicate is a successful no-op, not an error. */
export interface AppendResult {
  readonly event: EvidenceEvent;
  /** True when an identical fact was already journaled and this call added nothing. */
  readonly deduplicated: boolean;
}

export class JournalMutationError extends Error {
  override readonly name = 'JournalMutationError';
}

/** Redacted at the boundary. A payload containing any of these keys is rejected outright. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'privateKey',
  'private_key',
  'authorization',
  'Authorization',
  'apiKey',
  'api_key',
  'cookie',
  'Cookie',
  'secret',
  'password',
  'mnemonic',
  'seedPhrase',
] as const;
