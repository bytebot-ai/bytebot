-- v2.2.16: Add title column for AI-generated task summaries
-- title - short (max 100 chars) AI-generated summary of the task description
-- Used for task list display instead of full description

ALTER TABLE "Task" ADD COLUMN "title" VARCHAR(100);
