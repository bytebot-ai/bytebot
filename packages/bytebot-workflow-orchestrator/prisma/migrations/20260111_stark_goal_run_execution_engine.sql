-- Stark Fix vNext: Immutable per-run execution engine
--
-- Adds:
-- - workflow_orchestrator.GoalRunExecutionEngine enum: LEGACY_DB_LOOP | TEMPORAL_WORKFLOW
-- - workflow_orchestrator.goal_runs.execution_engine (NOT NULL, default LEGACY_DB_LOOP)
--
-- Invariant:
-- - execution_engine is set at run creation and MUST NOT change.
--
-- Safe to re-run (guarded).

-- ---------------------------------------------------------------------------
-- Enum (expand-only)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."GoalRunExecutionEngine" AS ENUM ('LEGACY_DB_LOOP', 'TEMPORAL_WORKFLOW');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Column + backfill
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.goal_runs
  ADD COLUMN IF NOT EXISTS execution_engine workflow_orchestrator."GoalRunExecutionEngine" NOT NULL DEFAULT 'LEGACY_DB_LOOP';

UPDATE workflow_orchestrator.goal_runs
SET execution_engine = 'LEGACY_DB_LOOP'
WHERE execution_engine IS NULL;

CREATE INDEX IF NOT EXISTS idx_goal_runs_execution_engine
  ON workflow_orchestrator.goal_runs(execution_engine);

-- ---------------------------------------------------------------------------
-- Immutability guard (DB-enforced)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_orchestrator.prevent_goal_run_execution_engine_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_engine IS DISTINCT FROM OLD.execution_engine THEN
    RAISE EXCEPTION 'goal_runs.execution_engine is immutable (old %, new %)', OLD.execution_engine, NEW.execution_engine
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'tr_goal_runs_execution_engine_immutable'
  ) THEN
    CREATE TRIGGER tr_goal_runs_execution_engine_immutable
      BEFORE UPDATE ON workflow_orchestrator.goal_runs
      FOR EACH ROW
      EXECUTE FUNCTION workflow_orchestrator.prevent_goal_run_execution_engine_update();
  END IF;
END $$;

ALTER TABLE IF EXISTS workflow_orchestrator.goal_runs OWNER TO bytebot;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'GoalRunExecutionEngine'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."GoalRunExecutionEngine" OWNER TO bytebot';
  END IF;
END $$;

