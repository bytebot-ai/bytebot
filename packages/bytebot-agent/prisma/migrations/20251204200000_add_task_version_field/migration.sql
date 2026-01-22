-- v2.0.28: Add version field for optimistic locking
-- This migration adds a version column to the Task table for detecting concurrent modifications
-- Safe for PostgreSQL 11+ as adding a column with a constant default is a metadata-only operation

ALTER TABLE "Task" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
