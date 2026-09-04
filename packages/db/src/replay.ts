import { readAggregate, type Queryable } from './journal.js';
import type { EvidenceEvent } from './types.js';

/**
 * Deterministic incident replay.
 *
 * Re-reads immutable journal rows up to a cutoff and reports what the evidence said at
 * that moment. It **never calls a live source** — a "replay" that does is not a replay,
 * it is a fresh observation wearing a historical label.
 *
 * The policy version that produced the original decision is reported alongside the one
 * used now. If they differ the result is still shown, clearly marked, rather than hidden:
 * a policy change between the recorded decision and the replay is expected, and concealing
 * it would make the replay less trustworthy, not more.
 */

export interface ReplayEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly observedAt: string;
  readonly sourceKind: string;
  readonly sourceLocator: string;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface ReplayResult {
  readonly assetId: string;
  readonly cutoffEventId: string | undefined;
  readonly eventCount: number;
  readonly events: readonly ReplayEvent[];
  /** What the evidence said at the cutoff, folded from the events alone. */
  readonly stateAtCutoff: {
    readonly canonicality: string | null;
    readonly sourceAgreement: string | null;
    readonly multiplierNonce: string | null;
    readonly lastApiObservationAt: string | null;
    readonly lastChainObservationAt: string | null;
    readonly lastBlockNumber: string | null;
  };
  /** True when every event carries the same producer version. A mix is worth surfacing. */
  readonly singleProducerVersion: boolean;
  readonly producerVersions: readonly string[];
}

/**
 * Redact before export.
 *
 * Evidence bundles get attached to tickets and pasted into chat. The journal already
 * refuses secret-bearing keys at write time, so this is defence in depth rather than the
 * only control — but an export is exactly where a second control earns its keep.
 */
const EXPORT_DENYLIST = /(?:key|secret|token|password|auth|cookie|signature|mnemonic)/i;

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = EXPORT_DENYLIST.test(k) ? '[redacted]' : v;
  }
  return out;
}

function toReplayEvent(event: EvidenceEvent): ReplayEvent {
  return {
    eventId: event.id,
    eventType: event.eventType,
    observedAt: event.observedAt.toISOString(),
    sourceKind: event.sourceKind,
    sourceLocator: event.sourceLocator,
    blockNumber: event.blockNumber?.toString() ?? null,
    blockHash: event.blockHash,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: redactPayload(event.payload),
  };
}

export async function replayAsset(
  db: Queryable,
  assetId: string,
  options: { readonly upToEventId?: string | undefined; readonly limit?: number } = {},
): Promise<ReplayResult> {
  const events = await readAggregate(db, 'asset', assetId, {
    ...(options.upToEventId === undefined ? {} : { upToEventId: options.upToEventId }),
    limit: options.limit ?? 500,
  });

  // Fold the events in order. This is the same shape as the projection fold, done from
  // immutable rows rather than from a cached table.
  let canonicality: string | null = null;
  let sourceAgreement: string | null = null;
  let multiplierNonce: string | null = null;
  let lastApi: string | null = null;
  let lastChain: string | null = null;
  let lastBlock: string | null = null;
  const producerVersions = new Set<string>();

  for (const event of events) {
    producerVersions.add(event.producerVersion);
    const p = event.payload;

    if (event.eventType === 'API_SNAPSHOT_OBSERVED' || event.eventType === 'ASSET_DISCOVERED') {
      lastApi = event.observedAt.toISOString();
    }
    if (event.eventType === 'CHAIN_SNAPSHOT_OBSERVED') {
      lastChain = event.observedAt.toISOString();
      lastBlock = event.blockNumber?.toString() ?? lastBlock;
      if (typeof p['canonicality'] === 'string') canonicality = p['canonicality'];
      if (typeof p['sourceAgreement'] === 'string') sourceAgreement = p['sourceAgreement'];
      if (typeof p['multiplierNonce'] === 'string') multiplierNonce = p['multiplierNonce'];
    }
  }

  return {
    assetId,
    cutoffEventId: options.upToEventId,
    eventCount: events.length,
    events: events.map(toReplayEvent),
    stateAtCutoff: {
      canonicality,
      sourceAgreement,
      multiplierNonce,
      lastApiObservationAt: lastApi,
      lastChainObservationAt: lastChain,
      lastBlockNumber: lastBlock,
    },
    // A replay spanning a code change is legitimate but must be visible: the decision may
    // have been produced by logic that no longer exists.
    singleProducerVersion: producerVersions.size <= 1,
    producerVersions: [...producerVersions],
  };
}
