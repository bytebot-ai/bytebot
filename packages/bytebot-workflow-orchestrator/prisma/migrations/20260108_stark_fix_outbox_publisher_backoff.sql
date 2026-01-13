-- Stark Fix (PR 3): Outbox publisher backoff scheduling
-- Adds a durable next_attempt_at timestamp to prevent tight retry loops.

ALTER TABLE IF EXISTS workflow_orchestrator.outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt_at
  ON workflow_orchestrator.outbox(next_attempt_at);

