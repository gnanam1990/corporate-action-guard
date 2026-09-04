-- 0007_fixture_evidence
--
-- A separately authenticated fixture control plane supplies chain-1952 intent evidence.
-- This is never accepted as xStocks production evidence and cannot target chain 196.

SET TIME ZONE 'UTC';

ALTER TYPE evidence_source_kind ADD VALUE IF NOT EXISTS 'FIXTURE_CONTROL_PLANE';

ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_known;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_known CHECK (
  scopes <@ ARRAY[
    'public:read', 'integrator:preflight', 'operator:review', 'admin:reconcile', 'admin:fixture'
  ]::text[]
);
