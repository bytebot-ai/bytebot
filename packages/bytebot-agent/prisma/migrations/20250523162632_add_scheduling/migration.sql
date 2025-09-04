-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledFor" TIMESTAMP(3);
