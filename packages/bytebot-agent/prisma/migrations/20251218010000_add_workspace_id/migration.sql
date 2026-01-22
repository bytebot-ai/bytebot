-- AlterTable
ALTER TABLE "Task" ADD COLUMN "workspaceId" VARCHAR(255);

-- CreateIndex
CREATE INDEX "Task_workspaceId_idx" ON "Task"("workspaceId");
