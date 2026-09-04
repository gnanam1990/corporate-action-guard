/**
 * Deterministic fault injection.
 *
 * Every claim this product makes is about behaviour under failure, and behaviour under
 * failure is the one thing that never gets exercised by accident. This harness makes each
 * failure reproducible on demand with a fixed seed.
 *
 * **It cannot be enabled in production.** `assertFaultsAllowed` throws when
 * `NODE_ENV === 'production'`, and the check is on the constructor rather than on each
 * call, so a production process carrying a stray `FAULTS=` variable fails at startup
 * rather than misbehaving quietly under load.
 */

export const FAULT_KINDS = [
  'XSTOCKS_TIMEOUT',
  'XSTOCKS_RATE_LIMITED',
  'XSTOCKS_INVALID_PAYLOAD',
  'XSTOCKS_STALE_RESPONSE',
  'RPC_TIMEOUT',
  'RPC_WRONG_CHAIN',
  'RPC_DIVERGENCE',
  'RPC_REORG',
  'DATABASE_UNAVAILABLE',
  'SIGNER_TIMEOUT',
  'SIGNER_UNKNOWN_OUTCOME',
  'WORKER_KILL_AFTER_APPEND',
  'DELAYED_TX_RECEIPT',
  'SCHEDULE_OVERRIDE_DURING_VALIDITY',
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * What each fault must produce. A harness that only injects failures proves nothing — the
 * expectation is the test.
 */
export interface FaultExpectation {
  readonly kind: FaultKind;
  /** The state the system must reach. */
  readonly expectedState: string;
  /** The reason code a preflight must return, if any. */
  readonly expectedBlockReason: string | undefined;
  /** The evidence that must appear in the journal. */
  readonly expectedEvidence: string;
  /** What an operator should see. */
  readonly expectedOperatorView: string;
  /** What must be true for the system to be considered recovered. */
  readonly recoveryCondition: string;
}

export const FAULT_EXPECTATIONS: Readonly<Record<FaultKind, FaultExpectation>> = {
  XSTOCKS_TIMEOUT: {
    kind: 'XSTOCKS_TIMEOUT',
    expectedState: 'source degraded',
    expectedBlockReason: 'API_UNAVAILABLE',
    expectedEvidence: 'SOURCE_DEGRADED for XSTOCKS_API',
    expectedOperatorView: 'Degraded evidence banner; last-known-good rows labelled STALE',
    recoveryCondition: 'A later successful catalog walk appends SOURCE_RECOVERED',
  },
  XSTOCKS_RATE_LIMITED: {
    kind: 'XSTOCKS_RATE_LIMITED',
    expectedState: 'source degraded after retry budget',
    expectedBlockReason: 'API_UNAVAILABLE',
    expectedEvidence: 'SOURCE_DEGRADED with the rate-limit detail',
    expectedOperatorView: 'Degraded banner; no partial catalog is written',
    recoveryCondition: 'Retry-After elapses and a walk completes',
  },
  XSTOCKS_INVALID_PAYLOAD: {
    kind: 'XSTOCKS_INVALID_PAYLOAD',
    expectedState: 'source degraded, no projection change',
    expectedBlockReason: 'API_UNAVAILABLE',
    expectedEvidence: 'SOURCE_DEGRADED; the previous catalog projection is untouched',
    expectedOperatorView: 'Degraded banner; prior rows remain, labelled STALE',
    recoveryCondition: 'A schema-valid response is observed',
  },
  XSTOCKS_STALE_RESPONSE: {
    kind: 'XSTOCKS_STALE_RESPONSE',
    expectedState: 'evidence beyond its freshness limit',
    expectedBlockReason: 'STALE_API_EVIDENCE',
    expectedEvidence: 'The API observation exists but its age exceeds the policy',
    expectedOperatorView: 'STALE badge on the API evidence column',
    recoveryCondition: 'A fresh observation lands within the freshness limit',
  },
  RPC_TIMEOUT: {
    kind: 'RPC_TIMEOUT',
    expectedState: 'source degraded',
    expectedBlockReason: 'RPC_UNAVAILABLE',
    expectedEvidence: 'SOURCE_DEGRADED for XLAYER_RPC',
    expectedOperatorView: 'Degraded banner naming the RPC',
    recoveryCondition: 'A head read succeeds',
  },
  RPC_WRONG_CHAIN: {
    kind: 'RPC_WRONG_CHAIN',
    expectedState: 'hard stop before any read is trusted',
    expectedBlockReason: 'RPC_UNAVAILABLE',
    expectedEvidence: 'SOURCE_DEGRADED with WRONG_CHAIN; no chain snapshot is written',
    expectedOperatorView: 'Degraded banner; no chain evidence appears',
    recoveryCondition: 'Configuration is corrected — never by overriding the check',
  },
  RPC_DIVERGENCE: {
    kind: 'RPC_DIVERGENCE',
    expectedState: 'the answering provider is recorded per read',
    expectedBlockReason: undefined,
    expectedEvidence: 'Each snapshot names the provider that answered',
    expectedOperatorView: 'Provider visible in the evidence drawer',
    recoveryCondition: 'Providers agree, or the divergence is escalated by an operator',
  },
  RPC_REORG: {
    kind: 'RPC_REORG',
    expectedState: 'cursor rewound, history retained',
    expectedBlockReason: undefined,
    expectedEvidence: 'REORG_DETECTED plus compensating evidence; the original is NOT deleted',
    expectedOperatorView: 'Reorg entry visible in the timeline alongside what was superseded',
    recoveryCondition: 'Re-indexing from the safe block completes',
  },
  DATABASE_UNAVAILABLE: {
    kind: 'DATABASE_UNAVAILABLE',
    expectedState: 'readiness unhealthy, liveness unaffected',
    expectedBlockReason: undefined,
    expectedEvidence: 'None — the journal is what is unavailable',
    expectedOperatorView: '503 from /v1/health/ready naming the database component',
    recoveryCondition: 'The database answers again; no data is lost, nothing was written',
  },
  SIGNER_TIMEOUT: {
    kind: 'SIGNER_TIMEOUT',
    expectedState: 'no receipt issued',
    expectedBlockReason: undefined,
    expectedEvidence: 'No RECEIPT_ISSUED event exists',
    expectedOperatorView: 'The preflight request fails; no placeholder receipt is returned',
    recoveryCondition: 'The signer responds; the caller retries with the same idempotency key',
  },
  SIGNER_UNKNOWN_OUTCOME: {
    kind: 'SIGNER_UNKNOWN_OUTCOME',
    expectedState: 'unknown, never assumed successful',
    expectedBlockReason: undefined,
    expectedEvidence: 'No RECEIPT_ISSUED unless the journal write completed',
    expectedOperatorView:
      'The request fails; a retry with the same key cannot mint a second receipt',
    recoveryCondition: 'Idempotent retry resolves to one receipt or none',
  },
  WORKER_KILL_AFTER_APPEND: {
    kind: 'WORKER_KILL_AFTER_APPEND',
    expectedState: 'no half-applied state',
    expectedBlockReason: undefined,
    expectedEvidence: 'The append and its projection share a transaction: both or neither',
    expectedOperatorView: 'The next cycle resumes; the lease expires and is retaken',
    recoveryCondition: 'A subsequent cycle completes',
  },
  DELAYED_TX_RECEIPT: {
    kind: 'DELAYED_TX_RECEIPT',
    expectedState: 'transaction outcome unknown, not failed',
    expectedBlockReason: undefined,
    expectedEvidence: 'The submitted hash is recorded before any outcome is claimed',
    expectedOperatorView: 'Pending, with the hash — never reported as executed',
    recoveryCondition: 'The receipt arrives, or the operator investigates by hash',
  },
  SCHEDULE_OVERRIDE_DURING_VALIDITY: {
    kind: 'SCHEDULE_OVERRIDE_DURING_VALIDITY',
    expectedState: 'the outstanding receipt is dead',
    expectedBlockReason: 'MULTIPLIER_NONCE_MISMATCH',
    expectedEvidence: 'The nonce advanced; the adapter rejects the old receipt on chain',
    expectedOperatorView: 'The asset moves to PENDING; the old receipt fails',
    recoveryCondition: 'A new preflight against the new nonce',
  },
};

export class FaultsNotAllowedError extends Error {
  override readonly name = 'FaultsNotAllowedError';
}

/**
 * Refuse to construct a fault injector in production.
 *
 * On the constructor rather than per call, so a production process carrying a stray
 * `FAULTS=` variable fails at startup instead of misbehaving quietly under load.
 */
export function assertFaultsAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') {
    throw new FaultsNotAllowedError(
      'Fault injection is not available in production. This is not configurable.',
    );
  }
}

/** Deterministic PRNG, so a scenario with a given seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FaultConfig {
  readonly kinds: readonly FaultKind[];
  /** 0 to 1. 1 means always. */
  readonly probability?: number;
  readonly seed?: number;
  readonly nodeEnv?: string | undefined;
}

export class FaultInjector {
  private readonly active: ReadonlySet<FaultKind>;
  private readonly probability: number;
  private readonly random: () => number;
  private readonly triggered = new Map<FaultKind, number>();

  constructor(config: FaultConfig) {
    assertFaultsAllowed(config.nodeEnv ?? process.env['NODE_ENV']);
    this.active = new Set(config.kinds);
    this.probability = config.probability ?? 1;
    this.random = mulberry32(config.seed ?? 1);
  }

  /** Parse `FAULTS=RPC_TIMEOUT,SIGNER_TIMEOUT`, ignoring unknown names loudly. */
  static fromEnv(value: string | undefined, seed?: number): FaultInjector | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const names = value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const kinds: FaultKind[] = [];
    for (const name of names) {
      if ((FAULT_KINDS as readonly string[]).includes(name)) kinds.push(name as FaultKind);
      else throw new Error(`unknown fault kind: ${name}. Known: ${FAULT_KINDS.join(', ')}`);
    }
    return new FaultInjector({ kinds, ...(seed === undefined ? {} : { seed }) });
  }

  shouldFail(kind: FaultKind): boolean {
    if (!this.active.has(kind)) return false;
    if (this.random() > this.probability) return false;
    this.triggered.set(kind, (this.triggered.get(kind) ?? 0) + 1);
    return true;
  }

  /** Throw the configured fault, or return. Callers use this at an I/O boundary. */
  maybeThrow(kind: FaultKind, error: () => Error): void {
    if (this.shouldFail(kind)) throw error();
  }

  timesTriggered(kind: FaultKind): number {
    return this.triggered.get(kind) ?? 0;
  }

  activeKinds(): readonly FaultKind[] {
    return [...this.active];
  }
}
