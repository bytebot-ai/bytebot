-- v2.2.5: Add lease columns for orphaned task recovery
-- claimedBy - which pod claimed the task (null if not claimed)
-- leaseExpiresAt - when the lease expires (task can be reclaimed after this time)

ALTER TABLE "Task" ADD COLUMN "claimedBy" VARCHAR(255);
ALTER TABLE "Task" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Create index for efficient orphaned task queries
CREATE INDEX "Task_leaseExpiresAt_status_idx" ON "Task"("leaseExpiresAt", "status");
