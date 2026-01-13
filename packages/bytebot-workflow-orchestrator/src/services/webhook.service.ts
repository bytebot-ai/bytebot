/**
 * Webhook Notification Service
 * Post-M5 Enhancement: Sends webhook notifications for approval events
 *
 * Best Practices Applied:
 * - HMAC-SHA256 signature verification for security
 * - Exponential backoff retry strategy (3 attempts)
 * - Idempotency key in each payload
 * - Standard event envelope format
 * - Configurable per-tenant webhooks
 *
 * Event Types:
 * - approval.requested: High-risk action awaiting approval
 * - approval.approved: Action was approved
 * - approval.rejected: Action was rejected
 * - approval.expired: Approval request expired
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import * as crypto from 'crypto';

/**
 * Webhook event types
 */
export enum WebhookEventType {
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_APPROVED = 'approval.approved',
  APPROVAL_REJECTED = 'approval.rejected',
  APPROVAL_EXPIRED = 'approval.expired',
}

/**
 * Webhook payload envelope
 */
export interface WebhookPayload {
  id: string; // Unique event ID (idempotency key)
  type: WebhookEventType;
  timestamp: string; // ISO 8601
  version: string; // API version
  data: WebhookEventData;
}

/**
 * Webhook event data
 */
export interface WebhookEventData {
  approvalId: string;
  nodeRunId: string;
  workflowRunId?: string;
  tenantId: string;
  toolName: string;
  riskLevel: string;
  summary: string;
  recipient?: string;
  subject?: string;
  // Decision info (for approved/rejected/expired)
  decision?: {
    status: string;
    reviewerId?: string;
    reason?: string;
    decidedAt?: string;
  };
  // Links for UI integration
  links?: {
    approval: string;
    workflow?: string;
  };
}

/**
 * Webhook configuration
 */
export interface WebhookConfig {
  id: string;
  tenantId: string;
  url: string;
  secret: string; // For HMAC signing
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: Date;
}

/**
 * Webhook delivery result
 */
export interface WebhookDeliveryResult {
  success: boolean;
  webhookId: string;
  eventId: string;
  statusCode?: number;
  responseBody?: string;
  error?: string;
  attempts: number;
  deliveredAt?: Date;
}

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly webhookTimeoutMs: number;
  private readonly baseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.webhookTimeoutMs = parseInt(
      this.configService.get<string>('WEBHOOK_TIMEOUT_MS', '10000'),
      10,
    );
    this.baseUrl = this.configService.get<string>(
      'APPROVAL_UI_BASE_URL',
      'https://app.bytebot.ai',
    );

    this.logger.log('WebhookService initialized');
  }

  /**
   * Send webhook notification for an approval event
   */
  async sendApprovalNotification(
    eventType: WebhookEventType,
    approval: {
      id: string;
      nodeRunId: string;
      toolName: string;
      previewData?: any;
      status: string;
      reason?: string;
      approvedBy?: string;
      rejectedBy?: string;
      approvedAt?: Date;
      rejectedAt?: Date;
    },
    tenantId: string,
  ): Promise<WebhookDeliveryResult[]> {
    // Get active webhooks for this tenant and event type
    const webhooks = await this.getActiveWebhooks(tenantId, eventType);

    if (webhooks.length === 0) {
      this.logger.debug(`No webhooks configured for ${eventType} in tenant ${tenantId}`);
      return [];
    }

    // Build payload
    const payload = this.buildPayload(eventType, approval, tenantId);

    // Log the audit event
    await this.logWebhookEvent(payload, webhooks.length);

    // Send to all configured webhooks
    const results: WebhookDeliveryResult[] = [];

    for (const webhook of webhooks) {
      const result = await this.deliverWebhook(webhook, payload);
      results.push(result);

      // Record delivery attempt
      await this.recordDeliveryAttempt(webhook.id, payload.id, result);
    }

    return results;
  }

  /**
   * Build webhook payload with standard envelope
   */
  private buildPayload(
    eventType: WebhookEventType,
    approval: any,
    tenantId: string,
  ): WebhookPayload {
    const preview = approval.previewData || {};

    const data: WebhookEventData = {
      approvalId: approval.id,
      nodeRunId: approval.nodeRunId,
      tenantId,
      toolName: approval.toolName,
      riskLevel: preview.riskLevel || 'UNKNOWN',
      summary: preview.summary || `Execute ${approval.toolName}`,
      recipient: preview.recipient,
      subject: preview.subject,
      links: {
        approval: `${this.baseUrl}/approvals/${approval.id}`,
      },
    };

    // Add decision info for non-requested events
    if (eventType !== WebhookEventType.APPROVAL_REQUESTED) {
      data.decision = {
        status: approval.status,
        reviewerId: approval.approvedBy || approval.rejectedBy,
        reason: approval.reason,
        decidedAt: (approval.approvedAt || approval.rejectedAt)?.toISOString(),
      };
    }

    return {
      id: this.generateEventId(),
      type: eventType,
      timestamp: new Date().toISOString(),
      version: '1.0',
      data,
    };
  }

  /**
   * Deliver webhook with retry logic
   */
  private async deliverWebhook(
    webhook: WebhookConfig,
    payload: WebhookPayload,
  ): Promise<WebhookDeliveryResult> {
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      attempts = attempt;

      try {
        const result = await this.sendWebhookRequest(webhook, payload);

        if (result.success) {
          this.logger.log(
            `Webhook delivered: ${webhook.id} -> ${payload.type} (attempt ${attempt})`,
          );

          return {
            success: true,
            webhookId: webhook.id,
            eventId: payload.id,
            statusCode: result.statusCode,
            attempts,
            deliveredAt: new Date(),
          };
        }

        lastStatusCode = result.statusCode;
        lastError = result.error;

        // Don't retry on 4xx errors (client errors)
        if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500) {
          this.logger.warn(
            `Webhook ${webhook.id} returned ${result.statusCode}, not retrying`,
          );
          break;
        }
      } catch (error: any) {
        lastError = error.message;
        this.logger.warn(
          `Webhook ${webhook.id} failed (attempt ${attempt}): ${error.message}`,
        );
      }

      // Exponential backoff before retry
      if (attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
          RETRY_CONFIG.maxDelayMs,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(
      `Webhook ${webhook.id} failed after ${attempts} attempts: ${lastError}`,
    );

    return {
      success: false,
      webhookId: webhook.id,
      eventId: payload.id,
      statusCode: lastStatusCode,
      error: lastError,
      attempts,
    };
  }

  /**
   * Send single webhook request with signature
   */
  private async sendWebhookRequest(
    webhook: WebhookConfig,
    payload: WebhookPayload,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const body = JSON.stringify(payload);
    const signature = this.generateSignature(body, webhook.secret);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.webhookTimeoutMs);

    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Id': webhook.id,
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestamp,
          'X-Event-Type': payload.type,
          'X-Event-Id': payload.id,
          'User-Agent': 'ByteBot-Webhook/1.0',
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 2xx status codes are success
      if (response.ok) {
        return { success: true, statusCode: response.status };
      }

      const responseText = await response.text().catch(() => '');
      return {
        success: false,
        statusCode: response.status,
        error: `HTTP ${response.status}: ${responseText.substring(0, 200)}`,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        return { success: false, error: `Timeout after ${this.webhookTimeoutMs}ms` };
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Generate HMAC-SHA256 signature
   * Format: sha256=<hex_signature>
   */
  private generateSignature(payload: string, secret: string): string {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  /**
   * Generate unique event ID
   */
  private generateEventId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `evt_${timestamp}_${random}`;
  }

  /**
   * Get active webhooks for tenant and event type
   */
  async getActiveWebhooks(
    tenantId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookConfig[]> {
    try {
      const webhooks = await this.prisma.webhookConfig.findMany({
        where: {
          tenantId,
          enabled: true,
          events: {
            has: eventType,
          },
        },
      });

      return webhooks.map((w) => ({
        id: w.id,
        tenantId: w.tenantId,
        url: w.url,
        secret: w.secret,
        events: w.events as WebhookEventType[],
        enabled: w.enabled,
        createdAt: w.createdAt,
      }));
    } catch (error: any) {
      // Table might not exist yet - return empty
      if (error.code === 'P2021' || error.message.includes('does not exist')) {
        this.logger.debug('WebhookConfig table not found, skipping webhooks');
        return [];
      }
      throw error;
    }
  }

  /**
   * Create webhook configuration for a tenant
   */
  async createWebhook(config: {
    tenantId: string;
    url: string;
    events: WebhookEventType[];
    secret?: string;
  }): Promise<WebhookConfig> {
    const secret = config.secret || this.generateWebhookSecret();

    const webhook = await this.prisma.webhookConfig.create({
      data: {
        tenantId: config.tenantId,
        url: config.url,
        secret,
        events: config.events,
        enabled: true,
      },
    });

    this.logger.log(`Created webhook ${webhook.id} for tenant ${config.tenantId}`);

    return {
      id: webhook.id,
      tenantId: webhook.tenantId,
      url: webhook.url,
      secret: webhook.secret,
      events: webhook.events as WebhookEventType[],
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
    };
  }

  /**
   * Update webhook configuration
   */
  async updateWebhook(
    webhookId: string,
    updates: {
      url?: string;
      events?: WebhookEventType[];
      enabled?: boolean;
    },
  ): Promise<WebhookConfig> {
    const webhook = await this.prisma.webhookConfig.update({
      where: { id: webhookId },
      data: updates,
    });

    return {
      id: webhook.id,
      tenantId: webhook.tenantId,
      url: webhook.url,
      secret: webhook.secret,
      events: webhook.events as WebhookEventType[],
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
    };
  }

  /**
   * Delete webhook configuration
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.prisma.webhookConfig.delete({
      where: { id: webhookId },
    });

    this.logger.log(`Deleted webhook ${webhookId}`);
  }

  /**
   * Rotate webhook secret
   */
  async rotateSecret(webhookId: string): Promise<{ secret: string }> {
    const newSecret = this.generateWebhookSecret();

    await this.prisma.webhookConfig.update({
      where: { id: webhookId },
      data: { secret: newSecret },
    });

    this.logger.log(`Rotated secret for webhook ${webhookId}`);

    return { secret: newSecret };
  }

  /**
   * Generate a secure webhook secret
   */
  private generateWebhookSecret(): string {
    return `whsec_${crypto.randomBytes(32).toString('hex')}`;
  }

  /**
   * Log webhook event for audit trail
   */
  private async logWebhookEvent(payload: WebhookPayload, webhookCount: number): Promise<void> {
    this.logger.log(
      `Webhook event: ${payload.type} for approval ${payload.data.approvalId} -> ${webhookCount} endpoints`,
    );
  }

  /**
   * Record delivery attempt for debugging/monitoring
   */
  private async recordDeliveryAttempt(
    webhookId: string,
    eventId: string,
    result: WebhookDeliveryResult,
  ): Promise<void> {
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          webhookId,
          eventId,
          success: result.success,
          statusCode: result.statusCode,
          error: result.error,
          attempts: result.attempts,
          deliveredAt: result.deliveredAt,
        },
      });
    } catch (error: any) {
      // Table might not exist - just log
      if (!error.message.includes('does not exist')) {
        this.logger.warn(`Failed to record delivery: ${error.message}`);
      }
    }
  }

  /**
   * Get webhook delivery history
   */
  async getDeliveryHistory(
    webhookId: string,
    limit: number = 50,
  ): Promise<any[]> {
    try {
      return await this.prisma.webhookDelivery.findMany({
        where: { webhookId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    } catch {
      return [];
    }
  }

  /**
   * Test webhook endpoint
   */
  async testWebhook(webhookId: string): Promise<WebhookDeliveryResult> {
    const webhook = await this.prisma.webhookConfig.findUnique({
      where: { id: webhookId },
    });

    if (!webhook) {
      throw new Error('Webhook not found');
    }

    const testPayload: WebhookPayload = {
      id: this.generateEventId(),
      type: WebhookEventType.APPROVAL_REQUESTED,
      timestamp: new Date().toISOString(),
      version: '1.0',
      data: {
        approvalId: 'test_approval_123',
        nodeRunId: 'test_node_run_123',
        tenantId: webhook.tenantId,
        toolName: 'communications_send_email',
        riskLevel: 'HIGH',
        summary: 'Test webhook notification',
        recipient: 'test@example.com',
        subject: 'Test Email',
        links: {
          approval: `${this.baseUrl}/approvals/test`,
        },
      },
    };

    const config: WebhookConfig = {
      id: webhook.id,
      tenantId: webhook.tenantId,
      url: webhook.url,
      secret: webhook.secret,
      events: webhook.events as WebhookEventType[],
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
    };

    return this.deliverWebhook(config, testPayload);
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
