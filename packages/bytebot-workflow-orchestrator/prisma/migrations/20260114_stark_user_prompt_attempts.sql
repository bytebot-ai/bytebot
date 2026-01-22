-- Stark Fix vNext: User Prompt Attempts (append-only)
--
-- Adds:
-- - workflow_orchestrator.user_prompt_attempts
--
-- Purpose:
-- - Record every prompt resolution submission attempt (including invalid attempts)
-- - Enable schema-driven validation feedback without mutating prompt history
-- - Provide audit-grade forensic trail for "help spam" and repeated resolution retries
--
-- Safe to re-run (IF NOT EXISTS / guarded indexes).

CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

CREATE TABLE IF NOT EXISTS workflow_orchestrator.user_prompt_attempts (
  id        VARCHAR(255) PRIMARY KEY,
  prompt_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.user_prompts(id) ON DELETE CASCADE,

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
  client_request_id TEXT,
  idempotency_key   TEXT,

  authz_decision TEXT NOT NULL DEFAULT 'ALLOW',
  authz_policy   TEXT,
  authz_rule_id  TEXT,
  authz_reason   TEXT,

  answers JSONB NOT NULL DEFAULT '{}'::jsonb,

  is_valid          BOOLEAN NOT NULL DEFAULT TRUE,
  validation_result JSONB,
  error_code        TEXT,
  error_message     TEXT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_user_prompt_attempts_tenant_id
  ON workflow_orchestrator.user_prompt_attempts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_attempts_goal_run_id
  ON workflow_orchestrator.user_prompt_attempts(goal_run_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_attempts_prompt_id
  ON workflow_orchestrator.user_prompt_attempts(prompt_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_attempts_actor_id
  ON workflow_orchestrator.user_prompt_attempts(actor_id);
CREATE INDEX IF NOT EXISTS idx_user_prompt_attempts_created_at
  ON workflow_orchestrator.user_prompt_attempts(created_at);

-- Idempotency (prompt-scoped)
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_prompt_attempts_prompt_id_idempotency_key
  ON workflow_orchestrator.user_prompt_attempts(prompt_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_prompt_attempts_prompt_id_client_request_id
  ON workflow_orchestrator.user_prompt_attempts(prompt_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

