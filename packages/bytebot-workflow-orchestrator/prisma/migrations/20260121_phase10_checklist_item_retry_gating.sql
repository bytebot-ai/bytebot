-- Stark Closeout: Durable retry gating for checklist items
--
-- Adds (workflow_orchestrator.checklist_items):
-- - infra_retry_count, infra_retry_after
-- - heartbeat_retry_count, heartbeat_retry_after
--
-- Purpose:
-- - Ensures exponential backoff is enforced even after a retry resets a step back to PENDING
-- - Makes retry behavior restart-safe and stable across leader changes / multiple replicas
--
-- Safe to re-run (guarded).

ALTER TABLE workflow_orchestrator.checklist_items
  ADD COLUMN IF NOT EXISTS infra_retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE workflow_orchestrator.checklist_items
  ADD COLUMN IF NOT EXISTS infra_retry_after timestamptz;

ALTER TABLE workflow_orchestrator.checklist_items
  ADD COLUMN IF NOT EXISTS heartbeat_retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE workflow_orchestrator.checklist_items
  ADD COLUMN IF NOT EXISTS heartbeat_retry_after timestamptz;

CREATE INDEX IF NOT EXISTS checklist_items_infra_retry_after_idx
  ON workflow_orchestrator.checklist_items (infra_retry_after);

CREATE INDEX IF NOT EXISTS checklist_items_heartbeat_retry_after_idx
  ON workflow_orchestrator.checklist_items (heartbeat_retry_after);

