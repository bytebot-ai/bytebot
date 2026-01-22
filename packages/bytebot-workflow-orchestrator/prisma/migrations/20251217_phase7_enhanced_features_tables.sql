-- Phase 7: Enhanced Features Tables
-- Creates tables for Goal Templates, Batch Execution, and Analytics
-- Run: psql -h <host> -U <user> -d <database> -f 20251217_phase7_enhanced_features_tables.sql

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

-- ============================================================================
-- Goal Template Table
-- Reusable templates for common goal patterns
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_templates (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,

    -- Template identification
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    tags TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    icon VARCHAR(100),

    -- Template content
    goal_pattern TEXT NOT NULL,
    default_constraints JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Variable definitions (array of { name, type, required, default, description })
    variables JSONB DEFAULT '[]'::jsonb NOT NULL,

    -- Checklist template (pre-defined plan steps)
    checklist_template JSONB DEFAULT '[]'::jsonb NOT NULL,

    -- Version control
    version VARCHAR(50) DEFAULT '1.0.0' NOT NULL,
    is_latest BOOLEAN DEFAULT TRUE NOT NULL,
    previous_version_id VARCHAR(255),

    -- Publishing status
    is_published BOOLEAN DEFAULT FALSE NOT NULL,
    is_built_in BOOLEAN DEFAULT FALSE NOT NULL,

    -- Usage tracking
    usage_count INTEGER DEFAULT 0 NOT NULL,
    last_used_at TIMESTAMP WITH TIME ZONE,

    -- Audit
    created_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,

    -- Constraints
    CONSTRAINT uq_goal_templates_tenant_name_version UNIQUE (tenant_id, name, version)
);

-- Indexes for goal_templates
DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_tenant_id ON workflow_orchestrator.goal_templates(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_tenant_published ON workflow_orchestrator.goal_templates(tenant_id, is_published)',
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_category ON workflow_orchestrator.goal_templates(category)',
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_is_built_in ON workflow_orchestrator.goal_templates(is_built_in)',
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_usage_count ON workflow_orchestrator.goal_templates(usage_count DESC)',
        'CREATE INDEX IF NOT EXISTS idx_goal_templates_created_at ON workflow_orchestrator.goal_templates(created_at)'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping index create (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Goal Run From Template Junction Table
-- Tracks which goal runs were created from templates
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_runs_from_template (
    id VARCHAR(255) PRIMARY KEY,
    goal_run_id VARCHAR(255) NOT NULL UNIQUE,
    template_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.goal_templates(id) ON DELETE CASCADE,

    -- Variables used when instantiating
    variable_values JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for goal_runs_from_template
DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_goal_runs_from_template_template_id ON workflow_orchestrator.goal_runs_from_template(template_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_runs_from_template_goal_run_id ON workflow_orchestrator.goal_runs_from_template(goal_run_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_runs_from_template_created_at ON workflow_orchestrator.goal_runs_from_template(created_at)'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping index create (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Goal Run Batch Table
-- Groups multiple goal runs for batch execution
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_run_batches (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,

    -- Batch identification
    name VARCHAR(255) NOT NULL,
    description TEXT,

    -- Batch configuration
    execution_mode VARCHAR(50) DEFAULT 'PARALLEL' NOT NULL,
    max_concurrency INTEGER DEFAULT 5 NOT NULL,
    stop_on_failure BOOLEAN DEFAULT FALSE NOT NULL,

    -- Batch status (PENDING, RUNNING, COMPLETED, PARTIALLY_COMPLETED, FAILED, CANCELLED)
    status VARCHAR(50) DEFAULT 'PENDING' NOT NULL,

    -- Progress tracking
    total_goals INTEGER DEFAULT 0 NOT NULL,
    completed_goals INTEGER DEFAULT 0 NOT NULL,
    failed_goals INTEGER DEFAULT 0 NOT NULL,
    cancelled_goals INTEGER DEFAULT 0 NOT NULL,

    -- Error tracking
    error TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for goal_run_batches
DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batches_tenant_id ON workflow_orchestrator.goal_run_batches(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batches_tenant_status ON workflow_orchestrator.goal_run_batches(tenant_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batches_status ON workflow_orchestrator.goal_run_batches(status)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batches_created_at ON workflow_orchestrator.goal_run_batches(created_at)'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping index create (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Goal Run Batch Item Table
-- Individual goal run within a batch
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_run_batch_items (
    id VARCHAR(255) PRIMARY KEY,
    batch_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.goal_run_batches(id) ON DELETE CASCADE,

    -- Goal definition
    goal TEXT NOT NULL,
    constraints JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Template reference (optional)
    template_id VARCHAR(255),
    variable_values JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Execution order (for SEQUENTIAL mode)
    "order" INTEGER DEFAULT 0 NOT NULL,

    -- Status tracking (PENDING, QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED, SKIPPED)
    status VARCHAR(50) DEFAULT 'PENDING' NOT NULL,
    goal_run_id VARCHAR(255),

    -- Error tracking
    error TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for goal_run_batch_items
DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batch_items_batch_id ON workflow_orchestrator.goal_run_batch_items(batch_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batch_items_batch_order ON workflow_orchestrator.goal_run_batch_items(batch_id, "order")',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batch_items_batch_status ON workflow_orchestrator.goal_run_batch_items(batch_id, status)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batch_items_goal_run_id ON workflow_orchestrator.goal_run_batch_items(goal_run_id)',
        'CREATE INDEX IF NOT EXISTS idx_goal_run_batch_items_status ON workflow_orchestrator.goal_run_batch_items(status)'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping index create (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Goal Run Analytics Snapshot Table
-- Pre-aggregated goal run metrics for analytics dashboard
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.goal_run_analytics_snapshots (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,

    -- Time bucket
    period VARCHAR(10) NOT NULL,  -- 1h, 1d, 7d, 30d
    bucket_start TIMESTAMP WITH TIME ZONE NOT NULL,
    bucket_end TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Goal Run Metrics
    total_goal_runs INTEGER DEFAULT 0 NOT NULL,
    completed_goal_runs INTEGER DEFAULT 0 NOT NULL,
    failed_goal_runs INTEGER DEFAULT 0 NOT NULL,
    cancelled_goal_runs INTEGER DEFAULT 0 NOT NULL,

    -- Duration metrics (in milliseconds)
    avg_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,
    min_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,
    max_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,
    p50_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,
    p95_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,
    p99_duration_ms DOUBLE PRECISION DEFAULT 0 NOT NULL,

    -- Step metrics
    avg_steps_per_goal DOUBLE PRECISION DEFAULT 0 NOT NULL,
    avg_replan_count DOUBLE PRECISION DEFAULT 0 NOT NULL,
    total_steps_executed INTEGER DEFAULT 0 NOT NULL,

    -- Template usage
    template_usage_count INTEGER DEFAULT 0 NOT NULL,
    top_template_id VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,

    -- Constraints
    CONSTRAINT uq_analytics_snapshots_tenant_period_bucket UNIQUE (tenant_id, period, bucket_start)
);

-- Indexes for goal_run_analytics_snapshots
DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_tenant_id ON workflow_orchestrator.goal_run_analytics_snapshots(tenant_id)',
        'CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_tenant_period ON workflow_orchestrator.goal_run_analytics_snapshots(tenant_id, period)',
        'CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_bucket_start ON workflow_orchestrator.goal_run_analytics_snapshots(bucket_start)',
        'CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_created_at ON workflow_orchestrator.goal_run_analytics_snapshots(created_at)'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping index create (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Trigger for updated_at timestamps
-- ============================================================================

-- Create or replace the timestamp update function
CREATE OR REPLACE FUNCTION workflow_orchestrator.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at column
DO $$
BEGIN
    BEGIN
        EXECUTE 'DROP TRIGGER IF EXISTS update_goal_templates_updated_at ON workflow_orchestrator.goal_templates';
        EXECUTE 'CREATE TRIGGER update_goal_templates_updated_at BEFORE UPDATE ON workflow_orchestrator.goal_templates FOR EACH ROW EXECUTE FUNCTION workflow_orchestrator.update_updated_at_column()';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping trigger update_goal_templates_updated_at (insufficient_privilege)';
    END;

    BEGIN
        EXECUTE 'DROP TRIGGER IF EXISTS update_goal_run_batches_updated_at ON workflow_orchestrator.goal_run_batches';
        EXECUTE 'CREATE TRIGGER update_goal_run_batches_updated_at BEFORE UPDATE ON workflow_orchestrator.goal_run_batches FOR EACH ROW EXECUTE FUNCTION workflow_orchestrator.update_updated_at_column()';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping trigger update_goal_run_batches_updated_at (insufficient_privilege)';
    END;

    BEGIN
        EXECUTE 'DROP TRIGGER IF EXISTS update_goal_run_batch_items_updated_at ON workflow_orchestrator.goal_run_batch_items';
        EXECUTE 'CREATE TRIGGER update_goal_run_batch_items_updated_at BEFORE UPDATE ON workflow_orchestrator.goal_run_batch_items FOR EACH ROW EXECUTE FUNCTION workflow_orchestrator.update_updated_at_column()';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'Skipping trigger update_goal_run_batch_items_updated_at (insufficient_privilege)';
    END;
END $$;

-- ============================================================================
-- Permissions
-- Grant all privileges to bytebot user for application access
-- ============================================================================

DO $$
DECLARE
    stmt TEXT;
BEGIN
    FOREACH stmt IN ARRAY ARRAY[
        'GRANT ALL PRIVILEGES ON workflow_orchestrator.goal_templates TO bytebot',
        'GRANT ALL PRIVILEGES ON workflow_orchestrator.goal_runs_from_template TO bytebot',
        'GRANT ALL PRIVILEGES ON workflow_orchestrator.goal_run_batches TO bytebot',
        'GRANT ALL PRIVILEGES ON workflow_orchestrator.goal_run_batch_items TO bytebot',
        'GRANT ALL PRIVILEGES ON workflow_orchestrator.goal_run_analytics_snapshots TO bytebot',
        'GRANT USAGE ON SCHEMA workflow_orchestrator TO bytebot'
    ]
    LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN insufficient_privilege THEN
                RAISE NOTICE 'Skipping grant (insufficient_privilege): %', stmt;
        END;
    END LOOP;
END $$;

-- ============================================================================
-- Verification
-- ============================================================================

DO $$
DECLARE
    table_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO table_count
    FROM information_schema.tables
    WHERE table_schema = 'workflow_orchestrator'
    AND table_name IN (
        'goal_templates',
        'goal_runs_from_template',
        'goal_run_batches',
        'goal_run_batch_items',
        'goal_run_analytics_snapshots'
    );

    IF table_count = 5 THEN
        RAISE NOTICE 'SUCCESS: All 5 Phase 7 Enhanced Features tables created successfully';
    ELSE
        RAISE WARNING 'WARNING: Expected 5 tables, found %', table_count;
    END IF;
END $$;
