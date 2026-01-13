-- Stark Fix vNext: Prompt scope + audit-grade authz fields + parent-agent actor type
--
-- Adds:
-- - ActorType.PARENT_AGENT (enum expansion)
-- - UserPromptScope enum + user_prompts.scope (explicit prompt scope)
-- - user_prompt_resolutions: client_request_id, idempotency_key, authz_* fields
--
-- Safe to re-run (guarded).

-- ---------------------------------------------------------------------------
-- Enums (expand-only)
-- ---------------------------------------------------------------------------

-- Add ActorType.PARENT_AGENT (guarded)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'ActorType'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'ActorType'
      AND e.enumlabel = 'PARENT_AGENT'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."ActorType" ADD VALUE ''PARENT_AGENT''';
  END IF;
END $$;

-- UserPromptScope enum
DO $$
BEGIN
  CREATE TYPE workflow_orchestrator."UserPromptScope" AS ENUM ('RUN', 'STEP', 'APPROVAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- user_prompts.scope (explicit semantic source of truth)
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts
  ADD COLUMN IF NOT EXISTS scope workflow_orchestrator."UserPromptScope" NOT NULL DEFAULT 'RUN';

-- Backfill scope from existing linkage columns (safe to re-run)
UPDATE workflow_orchestrator.user_prompts
SET scope = 'APPROVAL'
WHERE approval_request_id IS NOT NULL
  AND scope <> 'APPROVAL';

UPDATE workflow_orchestrator.user_prompts
SET scope = 'STEP'
WHERE approval_request_id IS NULL
  AND checklist_item_id IS NOT NULL
  AND scope <> 'STEP';

UPDATE workflow_orchestrator.user_prompts
SET scope = 'RUN'
WHERE approval_request_id IS NULL
  AND checklist_item_id IS NULL
  AND scope <> 'RUN';

CREATE INDEX IF NOT EXISTS idx_user_prompts_scope
  ON workflow_orchestrator.user_prompts(scope);

-- ---------------------------------------------------------------------------
-- user_prompt_resolutions audit-grade fields
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompt_resolutions
  ADD COLUMN IF NOT EXISTS client_request_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS authz_decision TEXT NOT NULL DEFAULT 'ALLOW',
  ADD COLUMN IF NOT EXISTS authz_policy TEXT,
  ADD COLUMN IF NOT EXISTS authz_rule_id TEXT,
  ADD COLUMN IF NOT EXISTS authz_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_client_request_id
  ON workflow_orchestrator.user_prompt_resolutions(client_request_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_idempotency_key
  ON workflow_orchestrator.user_prompt_resolutions(idempotency_key);

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts OWNER TO bytebot;
ALTER TABLE IF EXISTS workflow_orchestrator.user_prompt_resolutions OWNER TO bytebot;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'workflow_orchestrator'
      AND t.typname = 'UserPromptScope'
  ) THEN
    EXECUTE 'ALTER TYPE workflow_orchestrator."UserPromptScope" OWNER TO bytebot';
  END IF;
END $$;

