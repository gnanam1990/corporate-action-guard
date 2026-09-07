-- 0009_b20_preflight_idempotency
--
-- Durable preflight intents and their idempotency.
--
-- The ordering this table exists to enforce: the intent is persisted **before** the decision
-- is made and long before anything is signed. A service that decides first and records second
-- has a window where a crash loses the fact that it ever answered — and the client, retrying,
-- gets a second decision and possibly a second receipt for one operation.
--
-- Forward-only. Nothing here touches an existing table.

SET TIME ZONE 'UTC';

CREATE TABLE b20_preflight_intents (
    -- Tenant + route + key. Scoped this way because an idempotency key is chosen by the
    -- client: two tenants can pick the same one, and without the tenant in the key one
    -- would read the other's decision.
    tenant_id            text           NOT NULL,
    route                text           NOT NULL,
    idempotency_key      text           NOT NULL,

    -- Hash of the canonical operation. Same key + same bytes replays; same key + different
    -- bytes is a conflict, never a silent overwrite of what the first caller was told.
    request_hash         text           NOT NULL,

    operation_id         uuid           NOT NULL DEFAULT gen_random_uuid(),
    chain_id             bigint         NOT NULL,
    asset_address        text           NOT NULL,
    action_class         text           NOT NULL,
    sender               text           NOT NULL,
    recipient            text           NOT NULL,
    raw_amount           numeric(78, 0) NOT NULL,
    target_contract      text           NOT NULL,
    operation_digest     text           NOT NULL,
    expected_multiplier_wad numeric(78, 0) NOT NULL,

    -- Lifecycle. PENDING is written before the decision; a row that stays PENDING past its
    -- lease is a crashed request, and it is retried rather than assumed to have succeeded.
    status               text           NOT NULL DEFAULT 'PENDING',
    decision             text           NULL,
    reasons              text[]         NULL,
    policy_version       text           NULL,
    evaluated_at_seconds bigint         NULL,
    expires_at_seconds   bigint         NULL,

    -- At most one receipt per intent, enforced below rather than by application care.
    receipt_id           text           NULL,

    created_at           timestamptz    NOT NULL DEFAULT now(),
    updated_at           timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, route, idempotency_key),

    CONSTRAINT b20_intent_status CHECK (status IN ('PENDING', 'DECIDED', 'FAILED')),
    CONSTRAINT b20_intent_decision CHECK (decision IS NULL OR decision IN ('ALLOW', 'BLOCK', 'REVIEW')),
    -- A decided row must carry its decision and the policy version it was judged under; a
    -- policy change invalidates cached decisions, and a decision with no version cannot be
    -- invalidated because nothing knows what it was.
    CONSTRAINT b20_intent_decided_complete CHECK (
        status <> 'DECIDED'
        OR (decision IS NOT NULL AND policy_version IS NOT NULL AND evaluated_at_seconds IS NOT NULL)
    ),
    -- A receipt may only exist on an ALLOW. Not a code path that checks the decision before
    -- signing — a row that cannot exist.
    CONSTRAINT b20_intent_receipt_requires_allow CHECK (receipt_id IS NULL OR decision = 'ALLOW'),
    CONSTRAINT b20_intent_addresses_lowercase CHECK (
        asset_address = lower(asset_address)
        AND sender = lower(sender)
        AND recipient = lower(recipient)
        AND target_contract = lower(target_contract)
    ),
    CONSTRAINT b20_intent_request_hash_shape CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE b20_preflight_intents IS
    'Durable preflight intent. Written before the decision is made, so a crash between deciding and responding replays the stored result rather than deciding again.';
COMMENT ON COLUMN b20_preflight_intents.request_hash IS
    'Canonical operation hash. Same key + same hash replays the original result; same key + different hash is 409.';

CREATE UNIQUE INDEX b20_preflight_intents_operation_id ON b20_preflight_intents (operation_id);

-- One receipt per operation, across the whole table. A concurrent double-issue would violate
-- this before it could produce two signatures.
CREATE UNIQUE INDEX b20_preflight_intents_receipt_id
    ON b20_preflight_intents (receipt_id)
    WHERE receipt_id IS NOT NULL;

CREATE INDEX b20_preflight_intents_asset_idx
    ON b20_preflight_intents (chain_id, asset_address, created_at DESC);

-- `updated_at` is maintained by the database. A column the application sets is a column the
-- application forgets to set on the one path that matters.
CREATE OR REPLACE FUNCTION b20_preflight_intents_touch() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER b20_preflight_intents_touch_trigger
    BEFORE UPDATE ON b20_preflight_intents
    FOR EACH ROW EXECUTE FUNCTION b20_preflight_intents_touch();

-- The immutable half. A decided intent's decision, reasons and receipt never change: a
-- replay returns what the first caller was told, and "the decision was different last time"
-- is not a thing a client should ever be able to observe.
CREATE OR REPLACE FUNCTION b20_preflight_intents_reject_rewrite() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'DECIDED' THEN
        IF NEW.decision IS DISTINCT FROM OLD.decision
           OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
           OR NEW.operation_digest IS DISTINCT FROM OLD.operation_digest
           OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
        THEN
            RAISE EXCEPTION
                'a decided preflight intent is immutable; attempted to change its decision, '
                'request hash, digest or receipt (tenant %, key %)',
                OLD.tenant_id, OLD.idempotency_key
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER b20_preflight_intents_immutable_trigger
    BEFORE UPDATE ON b20_preflight_intents
    FOR EACH ROW EXECUTE FUNCTION b20_preflight_intents_reject_rewrite();
