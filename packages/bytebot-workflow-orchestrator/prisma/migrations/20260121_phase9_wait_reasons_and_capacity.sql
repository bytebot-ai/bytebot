-- Stark Closeout: Canonical wait reasons + WAITING_CAPACITY phase
--
-- Adds:
-- - workflow_orchestrator."GoalRunPhase" enum value: WAITING_CAPACITY
-- - workflow_orchestrator."GoalRunWaitReason" enum type
-- - workflow_orchestrator.goal_runs columns:
--     wait_reason, wait_detail, wait_started_at, wait_until
-- - Backfill wait_reason for existing waiting runs
--
-- Purpose:
-- - Make CAPACITY waits first-class (distinct from provider outages)
-- - Provide an engine-agnostic, audit-friendly “why are we waiting?” surface
--
-- Safe to re-run (guarded).

DO $$
BEGIN
  ALTER TYPE workflow_orchestrator."GoalRunPhase" ADD VALUE 'WAITING_CAPACITY';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."GoalRunWaitReason" AS ENUM (
    'USER_INPUT',
    'APPROVAL',
    'PROVIDER',
    'CAPACITY',
    'POLICY',
    'UNKNOWN'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE workflow_orchestrator.goal_runs
  ADD COLUMN IF NOT EXISTS wait_reason workflow_orchestrator."GoalRunWaitReason";

ALTER TABLE workflow_orchestrator.goal_runs
  ADD COLUMN IF NOT EXISTS wait_detail jsonb;

ALTER TABLE workflow_orchestrator.goal_runs
  ADD COLUMN IF NOT EXISTS wait_started_at timestamptz;

ALTER TABLE workflow_orchestrator.goal_runs
  ADD COLUMN IF NOT EXISTS wait_until timestamptz;

CREATE INDEX IF NOT EXISTS goal_runs_wait_reason_idx
  ON workflow_orchestrator.goal_runs (wait_reason);

-- Backfill existing waiting runs to have a durable wait_reason.
UPDATE workflow_orchestrator.goal_runs
SET
  wait_reason = 'USER_INPUT',
  wait_started_at = COALESCE(wait_started_at, updated_at)
WHERE
  phase = 'WAITING_USER_INPUT'
  AND wait_reason IS NULL;

UPDATE workflow_orchestrator.goal_runs
SET
  wait_reason = 'APPROVAL',
  wait_started_at = COALESCE(wait_started_at, updated_at)
WHERE
  phase = 'WAITING_APPROVAL'
  AND wait_reason IS NULL;

UPDATE workflow_orchestrator.goal_runs
SET
  wait_reason = 'PROVIDER',
  wait_started_at = COALESCE(wait_started_at, updated_at)
WHERE
  phase = 'WAITING_PROVIDER'
  AND wait_reason IS NULL;

