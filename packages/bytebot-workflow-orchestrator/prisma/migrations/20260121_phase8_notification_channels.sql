-- Phase 8: External Integrations - Notification Channels
--
-- Creates:
--   - workflow_orchestrator.notification_channels
--   - workflow_orchestrator.notification_deliveries
--
-- Design goals:
-- - Rerunnable (CREATE IF NOT EXISTS)
-- - Expand-only (no destructive changes)
-- - Matches Prisma schema models NotificationChannel / NotificationDelivery

CREATE SCHEMA IF NOT EXISTS workflow_orchestrator;

-- ---------------------------------------------------------------------------
-- notification_channels
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.notification_channels (
  id          VARCHAR(255) PRIMARY KEY,
  tenant_id   VARCHAR(255) NOT NULL,

  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,

  config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  events  TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,

  enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_channels_tenant_id
  ON workflow_orchestrator.notification_channels(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notification_channels_tenant_id_enabled
  ON workflow_orchestrator.notification_channels(tenant_id, enabled);
CREATE INDEX IF NOT EXISTS idx_notification_channels_tenant_id_type
  ON workflow_orchestrator.notification_channels(tenant_id, type);

-- ---------------------------------------------------------------------------
-- notification_deliveries
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_orchestrator.notification_deliveries (
  id         VARCHAR(255) PRIMARY KEY,
  channel_id VARCHAR(255) NOT NULL REFERENCES workflow_orchestrator.notification_channels(id) ON DELETE CASCADE,

  event_id   VARCHAR(255) NOT NULL,
  event_type TEXT NOT NULL,

  success     BOOLEAN NOT NULL,
  status_code INTEGER,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 1,

  payload JSONB DEFAULT '{}'::jsonb,

  delivered_at TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_channel_id
  ON workflow_orchestrator.notification_deliveries(channel_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_id
  ON workflow_orchestrator.notification_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_type
  ON workflow_orchestrator.notification_deliveries(event_type);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_created_at
  ON workflow_orchestrator.notification_deliveries(created_at);

