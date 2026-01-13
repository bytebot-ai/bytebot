-- P1 Hardening: persist Temporal workflow identifiers on goal_runs for auditability
-- IMPORTANT: This repo applies all prisma/migrations/*.sql on every Argo sync.
-- This migration MUST be idempotent.

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.goal_runs
    ADD COLUMN IF NOT EXISTS temporal_workflow_id text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.goal_runs
    ADD COLUMN IF NOT EXISTS temporal_run_id text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.goal_runs
    ADD COLUMN IF NOT EXISTS temporal_started_at timestamptz;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Best-effort backfill: workflowId is deterministic for current Temporal engine runs.
-- runId cannot be backfilled without querying Temporal history, so it remains NULL until start.
UPDATE workflow_orchestrator.goal_runs
SET temporal_workflow_id = COALESCE(temporal_workflow_id, 'goal-run-' || id)
WHERE execution_engine = 'TEMPORAL_WORKFLOW'
  AND temporal_workflow_id IS NULL;

-- Best-effort backfill for started time (use goal_runs.started_at as a proxy when present).
UPDATE workflow_orchestrator.goal_runs
SET temporal_started_at = COALESCE(temporal_started_at, started_at)
WHERE execution_engine = 'TEMPORAL_WORKFLOW'
  AND temporal_started_at IS NULL
  AND started_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS goal_runs_temporal_workflow_id_uidx
  ON workflow_orchestrator.goal_runs (temporal_workflow_id)
  WHERE temporal_workflow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS goal_runs_temporal_run_id_idx
  ON workflow_orchestrator.goal_runs (temporal_run_id);
