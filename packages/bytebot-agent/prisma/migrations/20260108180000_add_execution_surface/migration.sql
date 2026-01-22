-- PR5: ExecutionSurface propagation (agent DB)
-- Adds an explicit execution surface to enforce TEXT_ONLY vs DESKTOP execution paths.

CREATE TYPE "ExecutionSurface" AS ENUM ('TEXT_ONLY', 'DESKTOP');

ALTER TABLE "Task"
ADD COLUMN "executionSurface" "ExecutionSurface";

