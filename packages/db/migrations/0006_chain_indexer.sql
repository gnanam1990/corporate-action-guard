-- 0006_chain_indexer
--
-- Append-only cursor advancement and reorg compensation for adapter event ingestion.

SET TIME ZONE 'UTC';

ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'CHAIN_CURSOR_ADVANCED';
ALTER TYPE evidence_event_type ADD VALUE IF NOT EXISTS 'CHAIN_EVENTS_REVERTED';
