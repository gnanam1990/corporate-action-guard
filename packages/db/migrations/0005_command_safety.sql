-- 0005_command_safety
--
-- Persistent authentication and command durability. Raw API keys never enter this schema;
-- only their SHA-256 digests are stored.

SET TIME ZONE 'UTC';

CREATE TABLE api_keys (
    key_id       text        PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9]{8}$'),
    principal    text        NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
    key_hash     text        NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    scopes       text[]      NOT NULL,
    revoked_at   timestamptz NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT api_keys_scopes_nonempty CHECK (cardinality(scopes) > 0),
    CONSTRAINT api_keys_scopes_known CHECK (
      scopes <@ ARRAY[
        'public:read', 'integrator:preflight', 'operator:review', 'admin:reconcile'
      ]::text[]
    )
);

CREATE INDEX api_keys_active_idx ON api_keys (key_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE api_keys IS
    'Persistent API-key metadata. key_hash is SHA-256 over the full raw key; raw keys are never stored.';

COMMENT ON TABLE idempotency_keys IS
    'Durable command results. The preflight claim, evidence event, projection, and response complete atomically.';
