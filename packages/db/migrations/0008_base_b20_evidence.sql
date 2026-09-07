-- 0008_base_b20_evidence
--
-- Base B20 evidence and its rebuildable projections.
--
-- This extends the existing journal rather than creating a second source of truth. B20 facts
-- are appended to `evidence_events` with the same immutability trigger, the same canonical
-- payload hashing and the same correlation identifiers; only the event-type vocabulary and
-- the projection tables are new.
--
-- Forward-only. No existing evidence row is rewritten, no existing column changes type, and
-- every new column is nullable or lives on a new table — so an X Layer deployment that
-- applies this migration and never enables a Base feature is unaffected.

SET TIME ZONE 'UTC';

-- ---------------------------------------------------------------------------
-- Event vocabulary
-- ---------------------------------------------------------------------------
--
-- Added to the existing enum rather than introduced as a parallel type, so one query over
-- `evidence_events` still returns a tenant's whole history in one ordered stream.

ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MANIFEST_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MANIFEST_ACCEPTED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MANIFEST_REJECTED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_ASSET_STATE_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_CAPABILITY_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_LOG_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MULTIPLIER_SCHEDULED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MULTIPLIER_CANCELLED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MULTIPLIER_OVERRIDDEN';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_MULTIPLIER_MATURED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_ANNOUNCEMENT_OPENED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_ANNOUNCEMENT_CLOSED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_METADATA_CHANGED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_PAUSE_CHANGED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_POLICY_CHANGED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'CHAINLINK_ROUND_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'CHAINLINK_SEQUENCER_OBSERVED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_REORG_COMPENSATED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_CASE_CORRELATED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_LEDGER_POSTED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_CONFORMANCE_RUN';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_PREFLIGHT_REQUESTED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'B20_PREFLIGHT_DECIDED';

ALTER TYPE evidence_source_kind ADD VALUE IF NOT EXISTS 'BASE_RPC';
ALTER TYPE evidence_source_kind ADD VALUE IF NOT EXISTS 'CHAINLINK_FEED';
ALTER TYPE evidence_source_kind ADD VALUE IF NOT EXISTS 'OFFICIAL_ASSET_LIST';

-- The new enum labels are added but never *used* below: the projection tables reference
-- `evidence_events(id)` and constrain their own status columns as text. That is deliberate,
-- and it is what lets this whole migration run in the single transaction the runner opens —
-- Postgres refuses to use an enum value added in the same transaction, but adding one is
-- fine.

-- ---------------------------------------------------------------------------
-- Registry projection
-- ---------------------------------------------------------------------------
--
-- Identity is (chain_id, address). There is deliberately no unique index on symbol: symbols
-- are mutable on chain via `updateSymbol`, and a uniqueness constraint on one would turn a
-- legitimate rename into a write failure at exactly the moment the operator needs the record.

CREATE TABLE b20_assets (
    chain_id            bigint       NOT NULL,
    address             text         NOT NULL,

    display_symbol      text         NOT NULL,
    onchain_name        text         NOT NULL,
    onchain_symbol      text         NOT NULL,
    decimals            smallint     NOT NULL,

    -- VERIFIED | CHANGED | CONFLICT | RETIRED | UNKNOWN. Text rather than an enum so a new
    -- status does not require a migration lock on a hot table.
    status              text         NOT NULL,
    usable_for_action   boolean      NOT NULL,

    -- Where the issuer claim came from. An address with no provenance is a guess.
    issuer_source       text         NOT NULL,

    multiplier_wad      numeric(78, 0) NOT NULL,
    observed_block      numeric(78, 0) NOT NULL,
    observed_block_hash text         NOT NULL,
    observed_at         timestamptz  NOT NULL,

    PRIMARY KEY (chain_id, address),

    CONSTRAINT b20_assets_address_lowercase CHECK (address = lower(address)),
    CONSTRAINT b20_assets_block_hash_lowercase CHECK (observed_block_hash = lower(observed_block_hash)),
    CONSTRAINT b20_assets_decimals_range CHECK (decimals BETWEEN 6 AND 18),
    -- Mirrors the on-chain setter guard: zero is rejected, and a zero multiplier would
    -- silently zero every holder's share equivalent.
    CONSTRAINT b20_assets_multiplier_positive CHECK (multiplier_wad > 0),
    CONSTRAINT b20_assets_action_requires_verified CHECK (
        usable_for_action = false OR status = 'VERIFIED'
    )
);

COMMENT ON TABLE b20_assets IS
    'Projection of verified B20 asset identity. Rebuildable from evidence_events; never the source of truth.';
COMMENT ON COLUMN b20_assets.display_symbol IS
    'Display only. Symbols are mutable on chain and are never an identity key.';

-- Metadata history, so a rename is a new row rather than an overwrite. This is what makes
-- "the symbol changed on 12 March" answerable six months later.
CREATE TABLE b20_asset_metadata_history (
    id             bigserial     PRIMARY KEY,
    chain_id       bigint        NOT NULL,
    address        text          NOT NULL,
    onchain_name   text          NOT NULL,
    onchain_symbol text          NOT NULL,
    observed_block numeric(78, 0) NOT NULL,
    observed_at    timestamptz   NOT NULL,
    evidence_id    uuid          NOT NULL REFERENCES evidence_events (id),

    CONSTRAINT b20_metadata_address_lowercase CHECK (address = lower(address))
);

CREATE INDEX b20_asset_metadata_history_asset_idx
    ON b20_asset_metadata_history (chain_id, address, observed_block DESC);

-- ---------------------------------------------------------------------------
-- Capability projection
-- ---------------------------------------------------------------------------
--
-- One row per (chain, address, selector) observation window. The outcome vocabulary keeps
-- NOT_DIALED and UNAVAILABLE apart, because collapsing them turns an RPC outage into a
-- permanent claim that the chain does not support a feature.

CREATE TABLE b20_capabilities (
    chain_id       bigint        NOT NULL,
    address        text          NOT NULL,
    selector       text          NOT NULL,
    capability     text          NOT NULL,
    surface        text          NOT NULL,
    outcome        text          NOT NULL,
    revert_data    text          NULL,
    observed_block numeric(78, 0) NOT NULL,
    observed_at    timestamptz   NOT NULL,

    PRIMARY KEY (chain_id, address, selector),

    CONSTRAINT b20_capabilities_outcome CHECK (
        outcome IN ('LIVE', 'NOT_DIALED', 'REVERTED', 'UNAVAILABLE')
    ),
    CONSTRAINT b20_capabilities_surface CHECK (surface IN ('BERYL', 'COBALT_ERC8056')),
    CONSTRAINT b20_capabilities_selector_shape CHECK (selector ~ '^0x[0-9a-f]{8}$')
);

COMMENT ON COLUMN b20_capabilities.outcome IS
    'NOT_DIALED means the hardfork has not enabled the selector (it reverted with its own four bytes). UNAVAILABLE means the RPC failed and nothing about the capability is known.';

-- ---------------------------------------------------------------------------
-- Multiplier epochs
-- ---------------------------------------------------------------------------
--
-- Derived state, rebuilt by folding the lifecycle facts. `active_until` is exclusive and
-- NULL for the open epoch. `via_instant_override` records that the epoch began without a
-- scheduling window, which is the shape a mainnet corporate action has today.

CREATE TABLE b20_multiplier_epochs (
    id                   bigserial      PRIMARY KEY,
    chain_id             bigint         NOT NULL,
    address              text           NOT NULL,
    multiplier_wad       numeric(78, 0) NOT NULL,
    active_from_seconds  bigint         NOT NULL,
    active_until_seconds bigint         NULL,
    via_instant_override boolean        NOT NULL DEFAULT false,
    -- Event ids that produced this epoch. Plural: one instant update emits two events.
    source_event_ids     uuid[]         NOT NULL,

    CONSTRAINT b20_epochs_address_lowercase CHECK (address = lower(address)),
    CONSTRAINT b20_epochs_multiplier_positive CHECK (multiplier_wad > 0),
    CONSTRAINT b20_epochs_ordered CHECK (
        active_until_seconds IS NULL OR active_until_seconds >= active_from_seconds
    )
);

CREATE UNIQUE INDEX b20_multiplier_epochs_unique
    ON b20_multiplier_epochs (chain_id, address, active_from_seconds);

-- The pending schedule, when the chain can be asked at all. Absence of a row and inability
-- to ask are different states, which is why `capability_outcome` is recorded beside it.
CREATE TABLE b20_pending_schedules (
    chain_id             bigint         NOT NULL,
    address              text           NOT NULL,
    pending_multiplier_wad numeric(78, 0) NULL,
    effective_at_seconds bigint         NULL,
    capability_outcome   text           NOT NULL,
    observed_block       numeric(78, 0) NOT NULL,
    observed_at          timestamptz    NOT NULL,

    PRIMARY KEY (chain_id, address),

    CONSTRAINT b20_pending_capability CHECK (
        capability_outcome IN ('LIVE', 'NOT_DIALED', 'REVERTED', 'UNAVAILABLE')
    ),
    -- A pending multiplier without its effectiveAt cannot be evaluated, and an effectiveAt
    -- without a multiplier cannot either. Half a schedule is not a schedule.
    CONSTRAINT b20_pending_pair_complete CHECK (
        (pending_multiplier_wad IS NULL AND effective_at_seconds IS NULL)
        OR (pending_multiplier_wad IS NOT NULL AND effective_at_seconds IS NOT NULL)
    ),
    -- Only a LIVE capability may assert that nothing is pending. Anything else means the
    -- question could not be asked, and "no row" must not read as "no schedule".
    CONSTRAINT b20_pending_absence_requires_live CHECK (
        pending_multiplier_wad IS NOT NULL OR capability_outcome = 'LIVE'
    )
);

COMMENT ON TABLE b20_pending_schedules IS
    'A row with a NULL multiplier and capability_outcome LIVE means "nothing is scheduled". Any other capability_outcome means the chain could not be asked — never the same thing.';

-- ---------------------------------------------------------------------------
-- Source health
-- ---------------------------------------------------------------------------

CREATE TABLE b20_feed_observations (
    id                 bigserial      PRIMARY KEY,
    chain_id           bigint         NOT NULL,
    feed_proxy_address text           NOT NULL,
    token_address      text           NULL,
    price_basis        text           NOT NULL,
    round_id           numeric(78, 0) NOT NULL,
    answer             numeric(78, 0) NOT NULL,
    started_at_seconds bigint         NOT NULL,
    updated_at_seconds bigint         NOT NULL,
    answered_in_round  numeric(78, 0) NOT NULL,
    decimals           smallint       NOT NULL,
    verdict            text           NOT NULL,
    actionable         boolean        NOT NULL,
    policy_version     text           NOT NULL,
    observed_block     numeric(78, 0) NOT NULL,
    observed_block_hash text          NOT NULL,
    observed_at        timestamptz    NOT NULL,
    evidence_id        uuid           NOT NULL REFERENCES evidence_events (id),

    -- Every Coinbase equity feed on Base publishes the multiplier-adjusted token price.
    -- Recording the basis is what lets the valuation engine refuse the double multiplier.
    CONSTRAINT b20_feed_price_basis CHECK (
        price_basis IN ('TOTAL_RETURN_TOKEN_PRICE', 'UNDERLYING_EQUITY_PRICE')
    ),
    CONSTRAINT b20_feed_verdict CHECK (
        verdict IN ('FRESH', 'EXPECTED_HOLD', 'STALE', 'ISSUER_PAUSED',
                    'SEQUENCER_UNAVAILABLE', 'INVALID_ROUND')
    ),
    -- Only FRESH may back a money-moving decision. EXPECTED_HOLD is a correct price and an
    -- unacceptable input, and this constraint is what stops that distinction eroding.
    CONSTRAINT b20_feed_actionable_only_fresh CHECK (actionable = false OR verdict = 'FRESH')
);

CREATE UNIQUE INDEX b20_feed_observations_unique
    ON b20_feed_observations (chain_id, feed_proxy_address, round_id, observed_block);

CREATE INDEX b20_feed_observations_recent_idx
    ON b20_feed_observations (chain_id, feed_proxy_address, observed_block DESC);

-- ---------------------------------------------------------------------------
-- Ingestion cursors
-- ---------------------------------------------------------------------------
--
-- One cursor per (chain, address) partition, fenced so a resumed worker cannot be overtaken
-- by a stale one still holding an old lease. `last_indexed_block` advances only after the
-- journal commit — a cursor that moves first silently skips a range, which is the failure
-- where a corporate action is never observed and nothing reports an error.

CREATE TABLE b20_ingest_cursors (
    chain_id           bigint         NOT NULL,
    address            text           NOT NULL,
    last_indexed_block numeric(78, 0) NOT NULL,
    -- Retained block hashes for reorg detection, newest last, bounded by the lookback.
    recent_blocks      jsonb          NOT NULL DEFAULT '[]'::jsonb,
    fence              bigint         NOT NULL DEFAULT 1,
    updated_at         timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (chain_id, address),

    CONSTRAINT b20_cursor_address_lowercase CHECK (address = lower(address)),
    CONSTRAINT b20_cursor_block_nonnegative CHECK (last_indexed_block >= 0)
);

COMMENT ON COLUMN b20_ingest_cursors.fence IS
    'Monotonic fence token. Bumped on every reorg rewind so a stale worker mid-range cannot write over the replay.';

-- ---------------------------------------------------------------------------
-- Rebuildability
-- ---------------------------------------------------------------------------
--
-- Every table above is a projection. They may be truncated and regenerated by the explicit
-- maintenance flow, and a rebuild must reproduce identical content. The journal is not
-- listed here because it is never rebuilt — it is what everything else is rebuilt from.

CREATE OR REPLACE VIEW b20_projection_tables AS
SELECT unnest(ARRAY[
    'b20_assets',
    'b20_asset_metadata_history',
    'b20_capabilities',
    'b20_multiplier_epochs',
    'b20_pending_schedules',
    'b20_feed_observations'
]) AS table_name;

COMMENT ON VIEW b20_projection_tables IS
    'The Base projections a rebuild may truncate. b20_ingest_cursors is excluded: it is worker state, and truncating it would silently re-ingest history under a stale fence.';
