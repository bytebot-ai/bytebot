-- AlterTable: add `model` column as JSONB (nullable initially)
ALTER TABLE "Task" ADD COLUMN "model" JSONB;

-- Backfill existing tasks with the default Anthropic Claude Opus 4 model
UPDATE "Task"
SET "model" = jsonb_build_object(
  'provider', 'anthropic',
  'name', 'claude-opus-4-20250514',
  'title', 'Claude Opus 4'
)
WHERE "model" IS NULL;

-- Enforce NOT NULL constraint now that data is populated
ALTER TABLE "Task" ALTER COLUMN "model" SET NOT NULL;
