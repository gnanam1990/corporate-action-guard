-- 0002_evidence_journal
--
-- The append-only evidence journal and the projections rebuilt from it.
--
-- The journal is the source of truth. Projections are a cache of a fold over the journal
-- and can be dropped and rebuilt at any time. Nothing may UPDATE or DELETE a journal row
-- through the application role — history is never edited to make the UI look consistent.

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------
-- Event types
-- ---------------------------------------------------------------------------

CREATE TYPE evidence_event_type AS ENUM (
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
    'PROJECTION_REBUILT'
);

CREATE TYPE evidence_source_kind AS ENUM ('XSTOCKS_API', 'XLAYER_RPC', 'OPERATOR', 'SYSTEM');

CREATE TYPE lifecycle_state AS ENUM (
    'NORMAL', 'PENDING', 'GUARD_WINDOW', 'APPLIED', 'RECONCILED',
    'MISMATCH', 'MANUAL_REVIEW', 'RECOVERED'
);

CREATE TYPE check_outcome AS ENUM ('PASS', 'FAIL', 'UNKNOWN');

-- ---------------------------------------------------------------------------
-- The journal
-- ---------------------------------------------------------------------------

CREATE TABLE evidence_events (
    id               uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),

    aggregate_type   text                 NOT NULL,
    aggregate_id     text                 NOT NULL,

    event_type       evidence_event_type  NOT NULL,
    event_version    integer              NOT NULL DEFAULT 1,

    -- When this process saw it.
    observed_at      timestamptz          NOT NULL,
    -- When the source claims it was true. NULL when the source does not say; never
    -- silently substituted by observed_at.
    source_time      timestamptz          NULL,
    -- When it landed here. Set by the database, not the caller.
    ingested_at      timestamptz          NOT NULL DEFAULT now(),

    -- Chain provenance. Present together or not at all (see the check constraint below).
    chain_id         bigint               NULL,
    block_number     numeric(78, 0)       NULL,
    block_hash       text                 NULL,
    tx_hash          text                 NULL,
    log_index        integer              NULL,

    source_kind      evidence_source_kind NOT NULL,
    -- An endpoint path or provider identifier. Never a URL containing credentials.
    source_locator   text                 NOT NULL,

    payload          jsonb                NOT NULL,
    -- SHA-256 over the canonical (key-sorted) JSON encoding of payload. Stable across
    -- key order, so re-ingesting the same fact is detectable as the same fact.
    payload_hash     text                 NOT NULL,

    correlation_id   uuid                 NOT NULL,
    causation_id     uuid                 NULL,

    -- Code version that produced this row, so a replay can report which logic wrote it.
    producer_version text                 NOT NULL,

    CONSTRAINT evidence_events_block_provenance_complete CHECK (
        (block_number IS NULL AND block_hash IS NULL)
        OR (block_number IS NOT NULL AND block_hash IS NOT NULL AND chain_id IS NOT NULL)
    ),
    CONSTRAINT evidence_events_log_provenance_complete CHECK (
        (tx_hash IS NULL AND log_index IS NULL)
        OR (tx_hash IS NOT NULL AND log_index IS NOT NULL AND chain_id IS NOT NULL)
    ),
    CONSTRAINT evidence_events_addresses_lowercase CHECK (
        (block_hash IS NULL OR block_hash = lower(block_hash))
        AND (tx_hash IS NULL OR tx_hash = lower(tx_hash))
    ),
    CONSTRAINT evidence_events_payload_hash_shape CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE evidence_events IS
    'Append-only evidence journal. The source of truth. Never updated or deleted by the application role.';

-- Idempotency: the same chain log can be delivered more than once by a retry, a restart,
-- or a provider fallback. It is the same fact and must occupy one row.
CREATE UNIQUE INDEX evidence_events_unique_log
    ON evidence_events (chain_id, tx_hash, log_index)
    WHERE tx_hash IS NOT NULL;

-- Idempotency for source snapshots: the same payload observed within the same bucket is
-- the same observation. The bucket is supplied by the writer inside the payload as
-- `observationBucket`, so the policy is explicit and visible in the evidence itself
-- rather than hidden in an index expression.
CREATE UNIQUE INDEX evidence_events_unique_snapshot
    ON evidence_events (aggregate_type, aggregate_id, event_type, payload_hash, (payload ->> 'observationBucket'))
    WHERE event_type IN ('API_SNAPSHOT_OBSERVED', 'CHAIN_SNAPSHOT_OBSERVED');

CREATE INDEX evidence_events_aggregate_idx
    ON evidence_events (aggregate_type, aggregate_id, observed_at DESC, id DESC);
CREATE INDEX evidence_events_type_idx ON evidence_events (event_type, observed_at DESC);
CREATE INDEX evidence_events_correlation_idx ON evidence_events (correlation_id);
CREATE INDEX evidence_events_causation_idx ON evidence_events (causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX evidence_events_chain_block_idx
    ON evidence_events (chain_id, block_number DESC) WHERE block_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
--
-- A trigger, not a convention. An ORM mistake, a stray migration, or a well-meaning
-- "fix the data" query must fail loudly rather than quietly rewrite history.

CREATE OR REPLACE FUNCTION evidence_events_reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'evidence_events is append-only; % is not permitted (attempted on id %)',
        TG_OP, COALESCE(OLD.id::text, '(unknown)')
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_events_no_update
    BEFORE UPDATE ON evidence_events
    FOR EACH ROW EXECUTE FUNCTION evidence_events_reject_mutation();

CREATE TRIGGER evidence_events_no_delete
    BEFORE DELETE ON evidence_events
    FOR EACH ROW EXECUTE FUNCTION evidence_events_reject_mutation();

-- ---------------------------------------------------------------------------
-- Command idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
    -- Scoped to the actor so one integrator cannot collide with, or replay, another's key.
    actor_id       text        NOT NULL,
    operation      text        NOT NULL,
    idempotency_key text       NOT NULL,

    request_hash   text        NOT NULL,
    response_body  jsonb       NULL,
    status         text        NOT NULL CHECK (status IN ('IN_FLIGHT', 'COMPLETED', 'FAILED')),

    created_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz NULL,

    PRIMARY KEY (actor_id, operation, idempotency_key)
);

COMMENT ON COLUMN idempotency_keys.request_hash IS
    'Reusing a key with a different request body is a client error, not a cache hit.';

-- ---------------------------------------------------------------------------
-- Projections — derived, droppable, rebuildable
-- ---------------------------------------------------------------------------

CREATE TABLE current_assets (
    asset_id            text           PRIMARY KEY,
    symbol              text           NOT NULL,
    chain_id            bigint         NOT NULL,
    token_address       text           NOT NULL CHECK (token_address = lower(token_address)),
    wrapper_address     text           NULL CHECK (wrapper_address IS NULL OR wrapper_address = lower(wrapper_address)),
    wrapper_version     integer        NULL,
    wrapper_is_current  boolean        NULL,

    -- Fixed-point, never a float. value / 10^decimals.
    multiplier_value    numeric(78, 0) NULL,
    multiplier_decimals integer        NULL,
    multiplier_nonce    numeric(78, 0) NULL,
    scheduled_activation timestamptz   NULL,

    lifecycle_state     lifecycle_state NOT NULL DEFAULT 'NORMAL',
    canonicality        check_outcome   NOT NULL DEFAULT 'UNKNOWN',

    api_observed_at     timestamptz    NULL,
    chain_observed_at   timestamptz    NULL,
    chain_block_number  numeric(78, 0) NULL,
    chain_block_hash    text           NULL,

    -- The journal row this projection row was last folded from.
    last_event_id       uuid           NULL REFERENCES evidence_events (id),
    updated_at          timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT current_assets_multiplier_complete CHECK (
        (multiplier_value IS NULL AND multiplier_decimals IS NULL)
        OR (multiplier_value IS NOT NULL AND multiplier_decimals IS NOT NULL)
    )
);

CREATE INDEX current_assets_state_idx ON current_assets (lifecycle_state);
CREATE INDEX current_assets_symbol_idx ON current_assets (symbol);

CREATE TABLE current_source_health (
    source_kind    evidence_source_kind PRIMARY KEY,
    healthy        boolean              NOT NULL,
    -- NULL means "never succeeded", which is different from "succeeded long ago".
    last_success_at timestamptz         NULL,
    last_failure_at timestamptz         NULL,
    detail         text                 NOT NULL DEFAULT '',
    last_event_id  uuid                 NULL REFERENCES evidence_events (id),
    updated_at     timestamptz          NOT NULL DEFAULT now()
);

CREATE TABLE current_incidents (
    incident_id     uuid           PRIMARY KEY,
    asset_id        text           NOT NULL,
    -- Deterministic category. There is no numeric or model-generated risk score anywhere.
    severity        text           NOT NULL CHECK (severity IN ('SAFETY_CRITICAL', 'EVIDENCE_DEGRADED', 'INPUT_REJECTED')),
    status          text           NOT NULL CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'RECOVERED')),
    reason_codes    text[]         NOT NULL,
    -- Explicit dedup signature, computed by the writer from the ordered reason codes.
    -- Kept as a stored column rather than an index expression so the deduplication policy
    -- is visible in the row, and because array_to_string is not IMMUTABLE.
    reason_signature text          NOT NULL,
    first_detected_at timestamptz  NOT NULL,
    last_observed_at  timestamptz  NOT NULL,
    resolved_at     timestamptz    NULL,
    opened_by_event_id uuid        NOT NULL REFERENCES evidence_events (id),
    last_event_id   uuid           NULL REFERENCES evidence_events (id),
    updated_at      timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX current_incidents_open_idx ON current_incidents (status, severity, last_observed_at DESC);
CREATE INDEX current_incidents_asset_idx ON current_incidents (asset_id);

-- One open incident per asset per reason signature. A repeating identical mismatch
-- updates last_observed_at instead of creating an unbounded stream of duplicates.
CREATE UNIQUE INDEX current_incidents_one_open_per_signature
    ON current_incidents (asset_id, reason_signature)
    WHERE status IN ('OPEN', 'IN_REVIEW');

CREATE TABLE receipt_status (
    receipt_id       text           PRIMARY KEY,
    asset_id         text           NOT NULL,
    chain_id         bigint         NOT NULL,
    adapter_address  text           NOT NULL CHECK (adapter_address = lower(adapter_address)),
    operation_digest text           NOT NULL,
    valid_after      timestamptz    NOT NULL,
    valid_until      timestamptz    NOT NULL,
    status           text           NOT NULL CHECK (status IN ('ISSUED', 'CONSUMED', 'EXPIRED')),
    issued_event_id  uuid           NOT NULL REFERENCES evidence_events (id),
    consumed_event_id uuid          NULL REFERENCES evidence_events (id),
    consumed_tx_hash text           NULL CHECK (consumed_tx_hash IS NULL OR consumed_tx_hash = lower(consumed_tx_hash)),
    updated_at       timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT receipt_status_validity_ordered CHECK (valid_until > valid_after),
    -- A consumed receipt must name the event that consumed it. No silent consumption.
    CONSTRAINT receipt_status_consumed_has_evidence CHECK (
        status <> 'CONSUMED' OR consumed_event_id IS NOT NULL
    )
);

CREATE INDEX receipt_status_asset_idx ON receipt_status (asset_id, updated_at DESC);

CREATE TABLE indexed_chain_cursor (
    chain_id            bigint         PRIMARY KEY,
    last_indexed_block  numeric(78, 0) NOT NULL,
    last_indexed_hash   text           NOT NULL CHECK (last_indexed_hash = lower(last_indexed_hash)),
    -- Blocks below this are considered settled under the configured confirmation policy.
    safe_block          numeric(78, 0) NOT NULL,
    confirmation_depth  integer        NOT NULL,
    updated_at          timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT indexed_chain_cursor_safe_not_ahead CHECK (safe_block <= last_indexed_block)
);

-- Records each projection rebuild so a divergence investigation has a starting point.
CREATE TABLE projection_rebuilds (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    projection     text        NOT NULL,
    -- Rebuilt from journal rows up to and including this event.
    up_to_event_id uuid        NULL REFERENCES evidence_events (id),
    event_count    bigint      NOT NULL,
    started_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz NULL
);
