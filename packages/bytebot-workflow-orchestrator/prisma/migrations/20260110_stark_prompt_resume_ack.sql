-- Stark Fix vNext: Prompt resume acknowledgement + reconciler support
--
-- Adds:
-- - workflow_orchestrator.user_prompt_resolutions.resume_acknowledged_at (timestamp)
-- - workflow_orchestrator.user_prompt_resolutions.resume_ack (jsonb)
--
-- Backfill:
-- - If an existing prompt resolution has a processed resume outbox row, mark it acknowledged
--   to avoid reconciler churn on historic data.
--
-- Safe to re-run.

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompt_resolutions
  ADD COLUMN IF NOT EXISTS resume_acknowledged_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS resume_ack JSONB;

CREATE INDEX IF NOT EXISTS idx_user_prompt_resolutions_resume_acknowledged_at
  ON workflow_orchestrator.user_prompt_resolutions(resume_acknowledged_at);

-- Backfill ack for historical rows where the canonical resume outbox row already processed.
UPDATE workflow_orchestrator.user_prompt_resolutions r
SET
  resume_acknowledged_at = o.processed_at,
  resume_ack = COALESCE(r.resume_ack, '{}'::jsonb) || jsonb_build_object(
    'backfilled', true,
    'source', '20260110_stark_prompt_resume_ack',
    'outboxDedupeKey', o.dedupe_key
  )
FROM workflow_orchestrator.outbox o
WHERE r.resume_acknowledged_at IS NULL
  AND o.dedupe_key = ('user_prompt.resume:' || r.prompt_id)
  AND o.processed_at IS NOT NULL;

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompt_resolutions OWNER TO bytebot;

