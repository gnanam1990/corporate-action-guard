-- 0004_source_comparison
--
-- Records the result of comparing the API and the chain, per asset.
--
-- Until now the worker observed both sources but never compared them, so agreement was
-- permanently INCOMPLETE and every preflight blocked with SOURCE_MISMATCH. That is
-- fail-closed, which is the correct direction to be wrong in — but a guard that refuses
-- everything is not a guard, it is an outage.

SET TIME ZONE 'UTC';

CREATE TYPE source_agreement AS ENUM ('MATCH', 'MISMATCH', 'INCOMPLETE');

ALTER TABLE current_assets
    -- NULL means "never compared", which is distinct from INCOMPLETE ("compared, and one
    -- side could not supply a required field"). Both block; they are different diagnoses.
    ADD COLUMN source_agreement source_agreement NULL,
    ADD COLUMN comparison_fields jsonb NULL,
    ADD COLUMN compared_at timestamptz NULL;

COMMENT ON COLUMN current_assets.source_agreement IS
    'NULL = never compared. INCOMPLETE = compared but a required field was absent. Both block.';

COMMENT ON COLUMN current_assets.comparison_fields IS
    'Per-field API and chain values with their agreement, so an operator can see WHICH field disagrees.';
