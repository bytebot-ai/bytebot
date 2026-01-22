-- Desktop/Vision Reliability: WAITING_PROVIDER run phase
--
-- Adds:
-- - workflow_orchestrator."GoalRunPhase" enum value: WAITING_PROVIDER
--
-- Purpose:
-- - Allows the orchestrator to pause safely when LLM/provider capacity is unavailable
--   (instead of retry storms or semantic replans).
--
-- Safe to re-run (guarded).

DO $$
BEGIN
  ALTER TYPE workflow_orchestrator."GoalRunPhase" ADD VALUE 'WAITING_PROVIDER';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

