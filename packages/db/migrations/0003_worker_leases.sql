-- 0003_worker_leases
--
-- Durable leases so two workers never reconcile the same aggregate concurrently.
--
-- A PostgreSQL advisory lock alone is not enough: it vanishes when the connection drops,
-- which is exactly when a worker has died mid-cycle and its work needs to be visibly
-- owned until the lease expires. A row gives the lease an expiry, an owner, and a
-- heartbeat that survives a lost connection and is inspectable by an operator.

SET TIME ZONE 'UTC';

CREATE TABLE work_leases (
    -- e.g. 'reconcile:AAPLx' or 'index:196'
    lease_key     text        PRIMARY KEY,
    owner_id      text        NOT NULL,
    acquired_at   timestamptz NOT NULL DEFAULT now(),
    heartbeat_at  timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    -- Incremented on every acquisition, so a stale owner can detect it was superseded.
    fencing_token bigint      NOT NULL DEFAULT 1,

    CONSTRAINT work_leases_expiry_after_acquisition CHECK (expires_at > acquired_at)
);

COMMENT ON TABLE work_leases IS
    'Durable work leases. Survive a lost connection, unlike advisory locks, so a dead worker''s claim expires visibly rather than silently.';

CREATE INDEX work_leases_expiry_idx ON work_leases (expires_at);

-- Durable checkpoint per aggregate, so a restart resumes rather than restarts.
CREATE TABLE reconciliation_checkpoints (
    aggregate_id      text        PRIMARY KEY,
    last_cycle_at     timestamptz NOT NULL,
    last_outcome      text        NOT NULL,
    consecutive_failures integer  NOT NULL DEFAULT 0,
    -- Mismatch signature of the last cycle, so an identical repeat updates rather than
    -- appends a new incident.
    last_reason_signature text    NULL,
    updated_at        timestamptz NOT NULL DEFAULT now()
);
