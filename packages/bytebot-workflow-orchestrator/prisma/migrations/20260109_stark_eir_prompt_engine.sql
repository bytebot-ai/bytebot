-- Stark Fix vNext: External Input Request (EIR) / Prompt Engine Hardening
--
-- Adds/updates:
--   - workflow_orchestrator.goal_specs (GoalSpec gate before planning)
--   - workflow_orchestrator.desktop_leases (first-class desktop retention lease)
--   - workflow_orchestrator.user_prompts extensions:
--       - one OPEN prompt per run (partial unique index)
--       - revision/supersede pointers
--       - cancellation/expiry
--       - linkage to GoalSpec + ApprovalRequest + DesktopLease
--       - tenant_id (denormalized for query + access control)
--   - workflow_orchestrator.user_prompt_resolutions (immutable actor-stamped answers)
--   - workflow_orchestrator.outbox.event_sequence (monotonic cursor for replay)
--
-- Design goals:
-- - Schema-forward (expand-first), rerunnable, and safe under retries.
-- - Keep existing columns (e.g., user_prompts.answers) for backwards compatibility.
-- - No destructive changes; loosen constraints only where needed (checklist_item_id nullable).
--
-- IMPORTANT:
-- - Run using a DB role that can CREATE TYPE / ALTER TYPE / CREATE TABLE / ALTER TABLE.
-- - If you apply as a privileged role (e.g., postgres), ownership must be granted to the
--   ByteBot application role ("bytebot") at the end of this file.

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

-- ---------------------------------------------------------------------------
-- Enums (expand-only)
-- ---------------------------------------------------------------------------

-- Add UserPromptStatus.EXPIRED (guarded, supports reruns)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptStatus'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptStatus'
      AND e.enumlabel = 'EXPIRED'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptStatus" ADD VALUE ''EXPIRED''';
  END IF;
END $$;

-- Add UserPromptKind.GOAL_INTAKE + UserPromptKind.APPROVAL (guarded, supports reruns)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptKind'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptKind'
      AND e.enumlabel = 'GOAL_INTAKE'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptKind" ADD VALUE ''GOAL_INTAKE''';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptKind'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptKind'
      AND e.enumlabel = 'APPROVAL'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptKind" ADD VALUE ''APPROVAL''';
  END IF;
END $$;

-- UserPromptCancelReason enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."UserPromptCancelReason" AS ENUM (
    'SUPERSEDED',
    'USER_CANCELLED',
    'TIMEOUT',
    'POLICY_DENY',
    'RUN_ENDED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ActorType enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."ActorType" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- GoalSpecStatus enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."GoalSpecStatus" AS ENUM ('INCOMPLETE', 'COMPLETE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Desktop lease enums
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."DesktopLeaseMode" AS ENUM ('EPHEMERAL', 'WORKSPACE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."DesktopLeaseStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- goal_specs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_specs (
  id           VARCHAR(255) PRIMARY KEY,
  goal_run_id  VARCHAR(255) NOT NULL UNIQUE REFERENCES workflow_orchestrator.goal_runs(id) ON DELETE CASCADE,
  tenant_id    VARCHAR(255) NOT NULL,

  status       workflow_orchestrator."GoalSpecStatus" NOT NULL DEFAULT 'INCOMPLETE',

  schema_id      TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  json_schema    JSONB NOT NULL,
  ui_schema      JSONB,
  values         JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_goal_specs_tenant_id
  ON workflow_orchestrator.goal_specs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_goal_specs_status
  ON workflow_orchestrator.goal_specs(status);

-- ---------------------------------------------------------------------------
-- desktop_leases
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.desktop_leases (
  id          VARCHAR(255) PRIMARY KEY,
  tenant_id   VARCHAR(255) NOT NULL,
  goal_run_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.goal_runs(id) ON DELETE CASCADE,

  workspace_id VARCHAR(255),
  task_id      VARCHAR(255),

  mode   workflow_orchestrator."DesktopLeaseMode"   NOT NULL DEFAULT 'WORKSPACE',
  status workflow_orchestrator."DesktopLeaseStatus" NOT NULL DEFAULT 'ACTIVE',

  keepalive_until TIMESTAMP WITH TIME ZONE,
  expires_at      TIMESTAMP WITH TIME ZONE,
  released_at     TIMESTAMP WITH TIME ZONE,

  reason TEXT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_desktop_leases_tenant_id
  ON workflow_orchestrator.desktop_leases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_desktop_leases_goal_run_id
  ON workflow_orchestrator.desktop_leases(goal_run_id);
CREATE INDEX IF NOT EXISTS idx_desktop_leases_status
  ON workflow_orchestrator.desktop_leases(status);
CREATE INDEX IF NOT EXISTS idx_desktop_leases_keepalive_until
  ON workflow_orchestrator.desktop_leases(keepalive_until);

-- ---------------------------------------------------------------------------
-- user_prompts: expand + loosen constraints
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts
  ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS goal_spec_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS approval_request_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS desktop_lease_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS schema_id TEXT,
  ADD COLUMN IF NOT EXISTS schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS ui_schema JSONB,
  ADD COLUMN IF NOT EXISTS validator_version TEXT,
  ADD COLUMN IF NOT EXISTS root_prompt_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS supersedes_prompt_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS superseded_by_prompt_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cancel_reason workflow_orchestrator."UserPromptCancelReason",
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- Backfill tenant_id from goal_runs (safe to re-run)
UPDATE workflow_orchestrator.user_prompts up
SET tenant_id = gr.tenant_id
FROM workflow_orchestrator.goal_runs gr
WHERE up.goal_run_id = gr.id
  AND (up.tenant_id IS NULL OR up.tenant_id = '');

-- Allow goal-intake / approval prompts that are not tied to a checklist item.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'workflow_orchestrator'
      AND table_name = 'user_prompts'
      AND column_name = 'checklist_item_id'
      AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE workflow_orchestrator.user_prompts ALTER COLUMN checklist_item_id DROP NOT NULL';
  END IF;
END $$;

-- Add foreign keys (guarded)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_user_prompts_goal_spec_id'
  ) THEN
    EXECUTE 'ALTER TABLE workflow_orchestrator.user_prompts ' ||
      'ADD CONSTRAINT fk_user_prompts_goal_spec_id ' ||
      'FOREIGN KEY (goal_spec_id) REFERENCES workflow_orchestrator.goal_specs(id) ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_user_prompts_approval_request_id'
  ) THEN
    EXECUTE 'ALTER TABLE workflow_orchestrator.user_prompts ' ||
      'ADD CONSTRAINT fk_user_prompts_approval_request_id ' ||
      'FOREIGN KEY (approval_request_id) REFERENCES workflow_orchestrator.approval_requests(id) ON DELETE CASCADE';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_user_prompts_desktop_lease_id'
  ) THEN
    EXECUTE 'ALTER TABLE workflow_orchestrator.user_prompts ' ||
      'ADD CONSTRAINT fk_user_prompts_desktop_lease_id ' ||
      'FOREIGN KEY (desktop_lease_id) REFERENCES workflow_orchestrator.desktop_leases(id) ON DELETE CASCADE';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_prompts_tenant_id
  ON workflow_orchestrator.user_prompts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_goal_spec_id
  ON workflow_orchestrator.user_prompts(goal_spec_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_approval_request_id
  ON workflow_orchestrator.user_prompts(approval_request_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_desktop_lease_id
  ON workflow_orchestrator.user_prompts(desktop_lease_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_expires_at
  ON workflow_orchestrator.user_prompts(expires_at);

-- Exactly-one OPEN prompt per run (default policy)
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_prompts_one_open_per_run
  ON workflow_orchestrator.user_prompts(goal_run_id)
  WHERE status = 'OPEN';

-- ---------------------------------------------------------------------------
-- user_prompt_resolutions: immutable, actor-stamped answers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.user_prompt_resolutions (
  id        VARCHAR(255) PRIMARY KEY,
  prompt_id VARCHAR(255) NOT NULL UNIQUE REFERENCES workflow_orchestrator.user_prompts(id) ON DELETE CASCADE,

  tenant_id   VARCHAR(255) NOT NULL,
  goal_run_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.goal_runs(id) ON DELETE CASCADE,

  actor_type workflow_orchestrator."ActorType" NOT NULL,
  actor_id   VARCHAR(255),
  actor_email TEXT,
  actor_name  TEXT,
  actor_ip_address TEXT,
  actor_user_agent TEXT,

  request_id   TEXT,
  auth_context JSONB,

  answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_tenant_id
  ON workflow_orchestrator.user_prompt_resolutions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_goal_run_id
  ON workflow_orchestrator.user_prompt_resolutions(goal_run_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_actor_id
  ON workflow_orchestrator.user_prompt_resolutions(actor_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_created_at
  ON workflow_orchestrator.user_prompt_resolutions(created_at);

-- ---------------------------------------------------------------------------
-- outbox: monotonic cursor for replay
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.outbox
  ADD COLUMN IF NOT EXISTS event_sequence BIGINT GENERATED BY DEFAULT AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_outbox_event_sequence
  ON workflow_orchestrator.outbox(event_sequence);

-- ---------------------------------------------------------------------------
-- Ownership / privileges (critical for production)
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.goal_specs OWNER TO bytebot;
ALTER TABLE IF EXISTS workflow_orchestrator.desktop_leases OWNER TO bytebot;
ALTER TABLE IF EXISTS workflow_orchestrator.user_prompt_resolutions OWNER TO bytebot;

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts OWNER TO bytebot;
ALTER TABLE IF EXISTS workflow_orchestrator.outbox OWNER TO bytebot;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptCancelReason'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptCancelReason" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'ActorType'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."ActorType" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'GoalSpecStatus'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."GoalSpecStatus" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'DesktopLeaseMode'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."DesktopLeaseMode" OWNER TO bytebot';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'DesktopLeaseStatus'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."DesktopLeaseStatus" OWNER TO bytebot';
  END IF;
END $$;
