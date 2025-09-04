
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('IMMEDIATE', 'SCHEDULED');

-- AlterEnum
BEGIN;
CREATE TYPE "TaskStatus_new" AS ENUM ('PENDING', 'RUNNING', 'NEEDS_HELP', 'NEEDS_REVIEW', 'COMPLETED', 'CANCELLED', 'FAILED');
ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING (CASE "status"::text WHEN 'IN_PROGRESS' THEN 'RUNNING' ELSE "status"::text END::"TaskStatus_new");
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
DROP TYPE "TaskStatus_old";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_taskId_fkey";

-- DropForeignKey
ALTER TABLE "Summary" DROP CONSTRAINT "Summary_taskId_fkey";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "new_role" "Role" NOT NULL DEFAULT 'ASSISTANT';
UPDATE "Message"
SET "new_role" = CASE
    WHEN lower("role"::text) = 'user' THEN 'USER'::"Role"
    WHEN lower("role"::text) = 'assistant' THEN 'ASSISTANT'::"Role"
    ELSE 'ASSISTANT'::"Role"
END;

-- Step 3: Drop the old 'role' column.
ALTER TABLE "Message" DROP COLUMN "role";

-- Step 4: Rename 'new_role' to 'role'.
ALTER TABLE "Message" RENAME COLUMN "new_role" TO "role";

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "createdBy" "Role" NOT NULL DEFAULT 'USER',
ADD COLUMN     "error" TEXT,
ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "result" JSONB,
ADD COLUMN     "type" "TaskType" NOT NULL DEFAULT 'IMMEDIATE';

-- DropEnum
DROP TYPE "MessageRole";

-- AddForeignKey
ALTER TABLE "Summary" ADD CONSTRAINT "Summary_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
