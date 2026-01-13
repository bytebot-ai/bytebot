-- P0 Hardening (NEEDS_HELP durability): add explicit blocked metadata fields to checklist_items
-- IMPORTANT: This repo applies all prisma/migrations/*.sql on every Argo sync.
-- This migration MUST be idempotent.

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.checklist_items
    ADD COLUMN IF NOT EXISTS blocked_by_prompt_id text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.checklist_items
    ADD COLUMN IF NOT EXISTS blocked_reason text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE workflow_orchestrator.checklist_items
    ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Backfill best-effort from latest OPEN user_prompt for BLOCKED checklist items.
-- This avoids parsing arbitrary actual_outcome text as JSON.
WITH latest_open_prompt AS (
  SELECT DISTINCT ON (checklist_item_id)
    id,
    checklist_item_id,
    created_at
  FROM workflow_orchestrator.user_prompts
  WHERE checklist_item_id IS NOT NULL
    AND status = 'OPEN'
  ORDER BY checklist_item_id, created_at DESC
)
UPDATE workflow_orchestrator.checklist_items ci
SET
  blocked_by_prompt_id = lop.id,
  blocked_at = COALESCE(ci.blocked_at, lop.created_at),
  blocked_reason = COALESCE(ci.blocked_reason, 'WAITING_USER_INPUT')
FROM latest_open_prompt lop
WHERE ci.id = lop.checklist_item_id
  AND ci.status = 'BLOCKED'
  AND ci.blocked_by_prompt_id IS NULL;

CREATE INDEX IF NOT EXISTS checklist_items_blocked_by_prompt_id_idx
  ON workflow_orchestrator.checklist_items (blocked_by_prompt_id);

