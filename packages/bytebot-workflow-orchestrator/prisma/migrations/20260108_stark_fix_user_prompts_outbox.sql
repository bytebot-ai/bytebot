-- Stark Fix (Atom 1): Durable User Prompts + Outbox (Idempotent Notifications)
-- Creates:
--   - workflow_orchestrator.user_prompts (dedupe_key unique)
--   - workflow_orchestrator.outbox (dedupe_key unique)
-- Adds:
--   - GoalRunPhase.WAITING_USER_INPUT enum value
--   - checklist_items.step_type + checklist_items.execution_surface
--
-- Notes:
-- - Designed to be re-runnable (IF NOT EXISTS / guarded CREATE TYPE blocks).
-- - Run using a privileged DB role that can CREATE TYPE / ALTER TABLE.
-- - If you run as a privileged role (e.g., postgres), ensure ownership/privileges
--   are granted to the ByteBot application role ("bytebot") at the end of this file.

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Add GoalRunPhase.WAITING_USER_INPUT (guarded, supports reruns)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'GoalRunPhase'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'GoalRunPhase'
      AND e.enumlabel = 'WAITING_USER_INPUT'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."GoalRunPhase" ADD VALUE ''WAITING_USER_INPUT''';
  END IF;
END $$;

-- StepType enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."StepType" AS ENUM ('EXECUTE', 'USER_INPUT_REQUIRED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ExecutionSurface enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."ExecutionSurface" AS ENUM ('TEXT_ONLY', 'DESKTOP');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- UserPromptStatus enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."UserPromptStatus" AS ENUM ('OPEN', 'RESOLVED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- UserPromptKind enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."UserPromptKind" AS ENUM ('TEXT_CLARIFICATION', 'DESKTOP_TAKEOVER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- checklist_items: add step_type + execution_surface
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.checklist_items
  ADD COLUMN IF NOT EXISTS step_type workflow_orchestrator."StepType" NOT NULL DEFAULT 'EXECUTE',
  ADD COLUMN IF NOT EXISTS execution_surface workflow_orchestrator."ExecutionSurface" NOT NULL DEFAULT 'TEXT_ONLY';

-- Backfill execution_surface from requires_desktop for existing rows
UPDATE workflow_orchestrator.checklist_items
SET execution_surface = CASE
  WHEN requires_desktop THEN 'DESKTOP'::workflow_orchestrator."ExecutionSurface"
  ELSE 'TEXT_ONLY'::workflow_orchestrator."ExecutionSurface"
END;

-- ---------------------------------------------------------------------------
-- user_prompts: durable user interaction surface
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.user_prompts (
  id               VARCHAR(255) PRIMARY KEY,
  goal_run_id       VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.goal_runs(id) ON DELETE CASCADE,
  checklist_item_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.checklist_items(id) ON DELETE CASCADE,

  kind   workflow_orchestrator."UserPromptKind"   NOT NULL,
  status workflow_orchestrator."UserPromptStatus" NOT NULL DEFAULT 'OPEN',

  dedupe_key TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  answers    JSONB,

  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT uq_user_prompts_dedupe_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_user_prompts_goal_run_id
  ON workflow_orchestrator.user_prompts(goal_run_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_checklist_item_id
  ON workflow_orchestrator.user_prompts(checklist_item_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_status
  ON workflow_orchestrator.user_prompts(status);

-- ---------------------------------------------------------------------------
-- outbox: idempotent notifications (dedupe_key unique)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.outbox (
  id          VARCHAR(255) PRIMARY KEY,
  dedupe_key  TEXT NOT NULL,
  aggregate_id VARCHAR(255),
  event_type  VARCHAR(255) NOT NULL,
  payload     JSONB NOT NULL,

  processed_at TIMESTAMP WITH TIME ZONE,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_outbox_dedupe_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_processed_at
  ON workflow_orchestrator.outbox(processed_at);
CREATE INDEX IF NOT EXISTS idx_outbox_event_type
  ON workflow_orchestrator.outbox(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_id
  ON workflow_orchestrator.outbox(aggregate_id);

-- ---------------------------------------------------------------------------
-- Ownership / privileges (critical for production)
-- ---------------------------------------------------------------------------

-- Existing workflow_orchestrator tables are owned by the ByteBot DB role ("bytebot").
-- If you apply this migration as a privileged role (e.g., postgres), the new tables/types
-- will be owned by that privileged role by default which breaks runtime access.
-- Make ownership explicit so the orchestrator can read/write these objects.

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts OWNER TO bytebot;
ALTER TABLE IF EXISTS workflow_orchestrator.outbox OWNER TO bytebot;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'StepType'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."StepType" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'ExecutionSurface'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."ExecutionSurface" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptStatus'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptStatus" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptKind'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptKind" OWNER TO bytebot';
  END IF;
END $$;
