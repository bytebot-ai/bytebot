-- Phase 10: Enterprise Features Tables
-- Creates tables for multi-tenant administration, SSO, compliance, and LLM providers
-- Run: psql -h <host> -U <user> -d <database> -f 20251216_phase10_enterprise_tables.sql

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

-- ============================================================================
-- Tenant Table
-- Core tenant/organization management
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.tenants (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,

    -- Contact information
    admin_email VARCHAR(255) NOT NULL,
    admin_name VARCHAR(255),
    company_name VARCHAR(255),

    -- Subscription/billing
    plan VARCHAR(50) DEFAULT 'free' NOT NULL,
    billing_email VARCHAR(255),
    stripe_customer_id VARCHAR(255),

    -- Status
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    trial_ends TIMESTAMP WITH TIME ZONE,

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for tenants
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON workflow_orchestrator.tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON workflow_orchestrator.tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_plan ON workflow_orchestrator.tenants(plan);
CREATE INDEX IF NOT EXISTS idx_tenants_created_at ON workflow_orchestrator.tenants(created_at);

-- ============================================================================
-- Tenant Settings Table
-- Configurable settings per tenant
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.tenant_settings (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL UNIQUE REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- General settings
    timezone VARCHAR(50) DEFAULT 'UTC' NOT NULL,
    date_format VARCHAR(50) DEFAULT 'YYYY-MM-DD' NOT NULL,
    default_workspace_mode VARCHAR(50) DEFAULT 'SHARED' NOT NULL,

    -- Security settings
    require_mfa BOOLEAN DEFAULT FALSE NOT NULL,
    session_timeout INTEGER DEFAULT 3600 NOT NULL,
    ip_allowlist TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    allowed_domains TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,

    -- Workflow settings
    max_concurrent_goals INTEGER DEFAULT 5 NOT NULL,
    default_approval_timeout INTEGER DEFAULT 3600 NOT NULL,
    auto_replan_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    max_replan_attempts INTEGER DEFAULT 3 NOT NULL,

    -- Notification settings
    notification_email VARCHAR(255),
    slack_webhook_url TEXT,
    teams_webhook_url TEXT,
    webhook_secret_key VARCHAR(255),

    -- Data retention
    audit_log_retention_days INTEGER DEFAULT 365 NOT NULL,
    goal_run_retention_days INTEGER DEFAULT 90 NOT NULL,

    -- Feature flags
    features JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- ============================================================================
-- Tenant Quota Table
-- Usage quotas and limits per tenant
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.tenant_quotas (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL UNIQUE REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- Goal run limits
    monthly_goal_runs INTEGER DEFAULT 1000 NOT NULL,
    monthly_goal_runs_used INTEGER DEFAULT 0 NOT NULL,

    -- LLM token limits
    monthly_tokens INTEGER DEFAULT 1000000 NOT NULL,
    monthly_tokens_used INTEGER DEFAULT 0 NOT NULL,

    -- Storage limits (bytes)
    storage_limit BIGINT DEFAULT 10737418240 NOT NULL, -- 10GB
    storage_used BIGINT DEFAULT 0 NOT NULL,

    -- Concurrent limits
    max_concurrent_workspaces INTEGER DEFAULT 10 NOT NULL,
    max_users_per_tenant INTEGER DEFAULT 50 NOT NULL,
    max_templates INTEGER DEFAULT 100 NOT NULL,
    max_batch_size INTEGER DEFAULT 50 NOT NULL,

    -- API limits
    api_rate_limit_per_minute INTEGER DEFAULT 100 NOT NULL,

    -- Reset tracking
    quota_period_start TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- ============================================================================
-- SSO Configuration Table
-- SAML/SSO settings per tenant
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.sso_configurations (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL UNIQUE REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- SSO type
    provider VARCHAR(50) DEFAULT 'saml' NOT NULL,

    -- SAML configuration
    entity_id VARCHAR(512),
    sso_url TEXT,
    slo_url TEXT,
    certificate TEXT,
    signature_algorithm VARCHAR(50) DEFAULT 'sha256' NOT NULL,

    -- Attribute mapping
    attribute_mapping JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Just-in-time provisioning
    jit_provisioning BOOLEAN DEFAULT TRUE NOT NULL,
    default_role VARCHAR(50) DEFAULT 'member' NOT NULL,
    auto_update_attributes BOOLEAN DEFAULT TRUE NOT NULL,

    -- Domain validation
    enforced_domains TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    allow_bypass_sso BOOLEAN DEFAULT FALSE NOT NULL,

    -- Status
    enabled BOOLEAN DEFAULT FALSE NOT NULL,
    verified BOOLEAN DEFAULT FALSE NOT NULL,

    -- Metadata URLs
    idp_metadata_url TEXT,
    sp_metadata_url TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- ============================================================================
-- LLM Provider Configuration Table
-- Custom LLM provider settings per tenant
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.llm_provider_configs (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- Provider info
    provider VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE NOT NULL,

    -- Configuration
    api_key TEXT,
    api_endpoint TEXT,
    model VARCHAR(255),
    region VARCHAR(100),

    -- Provider-specific settings
    config JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Usage tracking
    total_tokens_used BIGINT DEFAULT 0 NOT NULL,
    total_requests_count INTEGER DEFAULT 0 NOT NULL,
    last_used_at TIMESTAMP WITH TIME ZONE,

    -- Fallback configuration
    priority INTEGER DEFAULT 0 NOT NULL,
    is_enabled BOOLEAN DEFAULT TRUE NOT NULL,
    is_fallback BOOLEAN DEFAULT FALSE NOT NULL,

    -- Rate limiting
    max_requests_per_minute INTEGER,
    max_tokens_per_request INTEGER,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,

    -- Unique constraint
    UNIQUE(tenant_id, provider, name)
);

-- Indexes for llm_provider_configs
CREATE INDEX IF NOT EXISTS idx_llm_provider_configs_tenant_id ON workflow_orchestrator.llm_provider_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_llm_provider_configs_tenant_default ON workflow_orchestrator.llm_provider_configs(tenant_id, is_default);
CREATE INDEX IF NOT EXISTS idx_llm_provider_configs_provider ON workflow_orchestrator.llm_provider_configs(provider);

-- ============================================================================
-- Compliance Report Table
-- Generated compliance reports (SOC2, GDPR)
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.compliance_reports (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- Report info
    report_type VARCHAR(100) NOT NULL,
    report_name VARCHAR(255) NOT NULL,
    report_period VARCHAR(50) NOT NULL,

    -- Date range
    start_date TIMESTAMP WITH TIME ZONE NOT NULL,
    end_date TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Report content
    summary TEXT,
    findings JSONB DEFAULT '[]'::jsonb NOT NULL,
    metrics JSONB DEFAULT '{}'::jsonb NOT NULL,

    -- Status
    status VARCHAR(50) DEFAULT 'generating' NOT NULL,
    generated_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,

    -- Export info
    export_format VARCHAR(50),
    export_url TEXT,

    -- Audit
    generated_by VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for compliance_reports
CREATE INDEX IF NOT EXISTS idx_compliance_reports_tenant_id ON workflow_orchestrator.compliance_reports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_tenant_type ON workflow_orchestrator.compliance_reports(tenant_id, report_type);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_type ON workflow_orchestrator.compliance_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_compliance_reports_created_at ON workflow_orchestrator.compliance_reports(created_at);

-- ============================================================================
-- Data Processing Record Table
-- GDPR Article 30 - Records of processing activities
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_orchestrator.data_processing_records (
    id VARCHAR(255) PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.tenants(id) ON DELETE CASCADE,

    -- Processing activity info
    activity_name VARCHAR(255) NOT NULL,
    activity_description TEXT,

    -- Data subjects
    data_subject_categories TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,

    -- Personal data categories
    personal_data_categories TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,

    -- Legal basis
    legal_basis VARCHAR(100) NOT NULL,
    legal_basis_details TEXT,

    -- Purpose
    processing_purposes TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,

    -- Recipients
    recipient_categories TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    third_country_transfers TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    transfer_safeguards TEXT,

    -- Retention
    retention_period VARCHAR(255),
    retention_criteria TEXT,

    -- Security measures
    technical_measures TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    organizational_measures TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,

    -- Status
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    review_date TIMESTAMP WITH TIME ZONE,
    reviewed_by VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Indexes for data_processing_records
CREATE INDEX IF NOT EXISTS idx_data_processing_records_tenant_id ON workflow_orchestrator.data_processing_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_data_processing_records_status ON workflow_orchestrator.data_processing_records(status);
CREATE INDEX IF NOT EXISTS idx_data_processing_records_legal_basis ON workflow_orchestrator.data_processing_records(legal_basis);

-- ============================================================================
-- Trigger for updated_at timestamps
-- ============================================================================

CREATE OR REPLACE FUNCTION workflow_orchestrator.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
        'tenants',
        'tenant_settings',
        'tenant_quotas',
        'sso_configurations',
        'llm_provider_configs',
        'compliance_reports',
        'data_processing_records'
    ])
    LOOP
        EXECUTE format('
            DROP TRIGGER IF EXISTS update_updated_at ON workflow_orchestrator.%I;
            CREATE TRIGGER update_updated_at
                BEFORE UPDATE ON workflow_orchestrator.%I
                FOR EACH ROW
                EXECUTE FUNCTION workflow_orchestrator.update_updated_at_column();
        ', t, t);
    END LOOP;
END;
$$;

-- ============================================================================
-- Grant permissions (adjust user as needed)
-- ============================================================================

-- Example: GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA workflow_orchestrator TO bytebot_app;

SELECT 'Phase 10 Enterprise tables created successfully' AS status;
