-- P0: Prompt schema snapshotting (fail-closed validation uses snapshot)
--
-- Adds:
-- - workflow_orchestrator.user_prompts.json_schema (JSONB)
--
-- Backfills:
-- - GOAL_INTAKE prompts from goal_specs + payload fallbacks
-- - schema_id/schema_version/ui_schema/validator_version where missing
--
-- Enforces:
-- - GOAL_INTAKE prompts must have json_schema (CHECK constraint)
--
-- Safe to re-run (guarded / idempotent).

ALTER TABLE IF EXISTS workflow_orchestrator.user_prompts
  ADD COLUMN IF NOT EXISTS json_schema jsonb;

-- Backfill GOAL_INTAKE prompt schema snapshots from goal_specs (authoritative) and payload (fallback).
UPDATE workflow_orchestrator.user_prompts p
SET
  schema_id = COALESCE(p.schema_id, gs.schema_id, p.payload->>'schemaId'),
  schema_version = COALESCE(p.schema_version, gs.schema_version, NULLIF(p.payload->>'schemaVersion','')::int),
  json_schema = COALESCE(p.json_schema, gs.json_schema, p.payload->'jsonSchema'),
  ui_schema = COALESCE(p.ui_schema, gs.ui_schema, p.payload->'uiSchema'),
  validator_version = COALESCE(p.validator_version, 'ajv@8')
FROM workflow_orchestrator.goal_specs gs
WHERE p.kind = 'GOAL_INTAKE'
  AND p.goal_spec_id = gs.id
  AND (
    p.schema_id IS NULL OR
    p.schema_version IS NULL OR
    p.json_schema IS NULL OR
    p.ui_schema IS NULL OR
    p.validator_version IS NULL
  );

-- Enforce: GOAL_INTAKE prompts require a schema snapshot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_user_prompts_goal_intake_requires_json_schema'
  ) THEN
    ALTER TABLE workflow_orchestrator.user_prompts
      ADD CONSTRAINT ck_user_prompts_goal_intake_requires_json_schema
      CHECK (kind <> 'GOAL_INTAKE' OR json_schema IS NOT NULL);
  END IF;
END $$;

