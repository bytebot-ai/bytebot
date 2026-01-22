-- Phase 6: Production Hardening - Performance Indexes
-- Created: 2025-12-15
-- Purpose: Add optimized indexes for high-volume query patterns

-- =============================================================================
-- Activity Events Table - Additional Performance Indexes
-- =============================================================================

-- Composite index for filtering by event type within time ranges
-- Useful for: "Show all STEP_COMPLETED events in the last hour"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_events_type_created
ON workflow_orchestrator.activity_events (event_type, created_at DESC);

-- Composite index for severity-based filtering within a goal run
-- Useful for: "Show all errors/warnings for this goal run"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_activity_events_goalrun_severity
ON workflow_orchestrator.activity_events (goal_run_id, severity, created_at DESC);

-- =============================================================================
-- Goal Runs Table - Additional Performance Indexes
-- =============================================================================

-- Composite index for tenant-specific status queries
-- Useful for: "Show all RUNNING goals for tenant X" (dashboard)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_goal_runs_tenant_status_created
ON workflow_orchestrator.goal_runs (tenant_id, status, created_at DESC);

-- Composite index for phase monitoring
-- Useful for: "Find all goals stuck in EXECUTING phase"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_goal_runs_phase_updated
ON workflow_orchestrator.goal_runs (phase, updated_at);

-- =============================================================================
-- Checklist Items Table - Additional Performance Indexes
-- =============================================================================

-- Composite index for status tracking within a plan
-- Useful for: "Show pending items for this plan version"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_checklist_items_plan_status
ON workflow_orchestrator.checklist_items (plan_version_id, status, "order");

-- =============================================================================
-- Workflow Execution Metrics - Time Series Optimization
-- =============================================================================

-- BRIN index for timestamp-based range scans on large metrics tables
-- BRIN indexes are much smaller than B-tree for time-series data
-- Only beneficial for tables > 100K rows with sequential inserts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wf_exec_metrics_timestamp_brin
ON workflow_orchestrator.workflow_execution_metrics
USING BRIN (timestamp) WITH (pages_per_range = 128);

-- =============================================================================
-- Workflow Step Metrics - Time Series Optimization
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wf_step_metrics_timestamp_brin
ON workflow_orchestrator.workflow_step_metrics
USING BRIN (timestamp) WITH (pages_per_range = 128);

-- =============================================================================
-- Dead Letter Entries - Recovery Queue Optimization
-- =============================================================================

-- Composite index for finding retryable entries
-- Useful for: "Find all entries ready for retry"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dead_letter_retry_queue
ON workflow_orchestrator.dead_letter_entries (status, next_retry_at)
WHERE status IN ('PENDING', 'RETRYING') AND next_retry_at IS NOT NULL;

-- =============================================================================
-- Index Statistics Update
-- =============================================================================

-- Analyze tables to update statistics for query planner
ANALYZE workflow_orchestrator.activity_events;
ANALYZE workflow_orchestrator.goal_runs;
ANALYZE workflow_orchestrator.checklist_items;
ANALYZE workflow_orchestrator.workflow_execution_metrics;
ANALYZE workflow_orchestrator.workflow_step_metrics;
ANALYZE workflow_orchestrator.dead_letter_entries;
