/*
  Warnings:

  - You are about to drop the column `type` on the `Message` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT');

-- AlterTable
ALTER TABLE "Message" DROP COLUMN "type",
ADD COLUMN     "role" "MessageRole" NOT NULL DEFAULT 'ASSISTANT';

-- DropEnum
DROP TYPE "MessageType";
