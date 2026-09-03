-- 0001_baseline
--
-- Baseline migration. Establishes the migration ledger and the invariants every later
-- migration relies on. It creates no product tables; the evidence journal arrives in
-- module 03.

-- Every instant this product compares is a UTC instant (ADR 0001).
SET TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS schema_migrations (
    version      text        PRIMARY KEY,
    checksum     text        NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE schema_migrations IS
    'Applied migration ledger. checksum pins file content so an edited applied migration is detected.';

-- gen_random_uuid() is used for evidence event ids in module 03.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
