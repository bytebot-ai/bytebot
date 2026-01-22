/**
 * Audit Logging Service
 * Post-M5 Enhancement: Compliance-ready audit trail for approval actions
 *
 * Best Practices Applied:
 * - Immutable audit records (no update/delete)
 * - Capture: WHO, WHAT, WHEN, WHERE, WHY
 * - Structured JSON format for searchability
 * - Retention policy support
 * - SOC2/GDPR compliance considerations
 *
 * Audit Event Types:
 * - APPROVAL_REQUESTED: High-risk action awaiting approval
 * - APPROVAL_VIEWED: Approver viewed the request
 * - APPROVAL_APPROVED: Action was approved
 * - APPROVAL_REJECTED: Action was rejected
 * - APPROVAL_EXPIRED: Request expired without decision
 * - APPROVAL_EXECUTED: Approved action was executed
 * - USER_PROMPT_CREATED: External input request created
 * - USER_PROMPT_RESOLVED: External input request resolved
 * - USER_PROMPT_CANCELLED: External input request cancelled/superseded
 * - USER_PROMPT_EXPIRED: External input request expired
 * - WEBHOOK_SENT: Notification webhook delivered
 * - WEBHOOK_FAILED: Notification webhook failed
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

/**
 * Audit event types for approval workflow
 */
export enum AuditEventType {
  // Approval lifecycle
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  APPROVAL_VIEWED = 'APPROVAL_VIEWED',
  APPROVAL_APPROVED = 'APPROVAL_APPROVED',
  APPROVAL_REJECTED = 'APPROVAL_REJECTED',
  APPROVAL_EXPIRED = 'APPROVAL_EXPIRED',
  APPROVAL_EXECUTED = 'APPROVAL_EXECUTED',

  // Webhook events
  WEBHOOK_SENT = 'WEBHOOK_SENT',
  WEBHOOK_FAILED = 'WEBHOOK_FAILED',

  // External input requests (EIR / prompts)
  USER_PROMPT_CREATED = 'USER_PROMPT_CREATED',
  USER_PROMPT_RESOLVED = 'USER_PROMPT_RESOLVED',
  USER_PROMPT_CANCELLED = 'USER_PROMPT_CANCELLED',
  USER_PROMPT_EXPIRED = 'USER_PROMPT_EXPIRED',

  // Administrative events
  WEBHOOK_CREATED = 'WEBHOOK_CREATED',
  WEBHOOK_UPDATED = 'WEBHOOK_UPDATED',
  WEBHOOK_DELETED = 'WEBHOOK_DELETED',
  WEBHOOK_SECRET_ROTATED = 'WEBHOOK_SECRET_ROTATED',
}

/**
 * Audit log entry - immutable record
 */
export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;

  // WHO - Actor information
  actor: {
    type: 'user' | 'system' | 'agent';
    id?: string;
    email?: string;
    name?: string;
    ipAddress?: string;
    userAgent?: string;
  };

  // WHAT - Resource being acted upon
  resource: {
    type: 'approval' | 'webhook' | 'workflow' | 'node' | 'prompt' | 'goal_spec' | 'desktop_lease';
    id: string;
    name?: string;
  };

  // WHERE - Context
  context: {
    tenantId: string;
    workspaceId?: string;
    workflowRunId?: string;
    nodeRunId?: string;
    requestId?: string;
  };

  // WHY - Action details
  action: {
    type: string;
    reason?: string;
    previousState?: string;
    newState?: string;
  };

  // Additional metadata
  metadata?: Record<string, any>;
}

/**
 * Input for creating audit log entry
 */
export interface CreateAuditLogInput {
  eventType: AuditEventType;
  actor: AuditLogEntry['actor'];
  resource: AuditLogEntry['resource'];
  context: AuditLogEntry['context'];
  action: AuditLogEntry['action'];
  metadata?: Record<string, any>;
}

/**
 * Query options for audit logs
 */
export interface AuditLogQuery {
  tenantId: string;
  eventTypes?: AuditEventType[];
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.retentionDays = parseInt(
      this.configService.get<string>('AUDIT_LOG_RETENTION_DAYS', '365'),
      10,
    );

    this.logger.log(`AuditService initialized (retention: ${this.retentionDays} days)`);
  }

  /**
   * Create an immutable audit log entry
   */
  async log(input: CreateAuditLogInput): Promise<AuditLogEntry> {
    const entry = await this.prisma.auditLog.create({
      data: {
        eventType: input.eventType,
        actorType: input.actor.type,
        actorId: input.actor.id,
        actorEmail: input.actor.email,
        actorName: input.actor.name,
        actorIpAddress: input.actor.ipAddress,
        actorUserAgent: input.actor.userAgent,
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        resourceName: input.resource.name,
        tenantId: input.context.tenantId,
        workspaceId: input.context.workspaceId,
        workflowRunId: input.context.workflowRunId,
        nodeRunId: input.context.nodeRunId,
        requestId: input.context.requestId,
        actionType: input.action.type,
        actionReason: input.action.reason,
        previousState: input.action.previousState,
        newState: input.action.newState,
        metadata: input.metadata,
        expiresAt: new Date(Date.now() + this.retentionDays * 24 * 60 * 60 * 1000),
      },
    });

    this.logger.debug(
      `Audit log created: ${input.eventType} on ${input.resource.type}:${input.resource.id}`,
    );

    return this.mapToEntry(entry);
  }

  /**
   * Log approval request created
   */
  async logApprovalRequested(
    approval: {
      id: string;
      nodeRunId: string;
      toolName: string;
      previewData?: any;
    },
    context: {
      tenantId: string;
      workspaceId?: string;
      workflowRunId?: string;
    },
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_REQUESTED,
      actor: { type: 'agent', id: 'bytebot-agent' },
      resource: { type: 'approval', id: approval.id, name: approval.toolName },
      context: {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        workflowRunId: context.workflowRunId,
        nodeRunId: approval.nodeRunId,
      },
      action: {
        type: 'create',
        newState: 'PENDING',
      },
      metadata: {
        toolName: approval.toolName,
        riskLevel: approval.previewData?.riskLevel,
        summary: approval.previewData?.summary,
        recipient: approval.previewData?.recipient,
      },
    });
  }

  /**
   * Log approval decision (approved or rejected)
   */
  async logApprovalDecision(
    approval: {
      id: string;
      nodeRunId: string;
      toolName: string;
      status: string;
      reason?: string;
    },
    reviewer: {
      id: string;
      email?: string;
      name?: string;
      ipAddress?: string;
      userAgent?: string;
    },
    context: {
      tenantId: string;
      workspaceId?: string;
      workflowRunId?: string;
    },
    approved: boolean,
  ): Promise<void> {
    await this.log({
      eventType: approved
        ? AuditEventType.APPROVAL_APPROVED
        : AuditEventType.APPROVAL_REJECTED,
      actor: {
        type: 'user',
        id: reviewer.id,
        email: reviewer.email,
        name: reviewer.name,
        ipAddress: reviewer.ipAddress,
        userAgent: reviewer.userAgent,
      },
      resource: { type: 'approval', id: approval.id, name: approval.toolName },
      context: {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        workflowRunId: context.workflowRunId,
        nodeRunId: approval.nodeRunId,
      },
      action: {
        type: approved ? 'approve' : 'reject',
        reason: approval.reason,
        previousState: 'PENDING',
        newState: approval.status,
      },
    });
  }

  /**
   * Log approval expiration
   */
  async logApprovalExpired(
    approval: {
      id: string;
      nodeRunId: string;
      toolName: string;
    },
    context: {
      tenantId: string;
      workspaceId?: string;
      workflowRunId?: string;
    },
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_EXPIRED,
      actor: { type: 'system', id: 'cleanup-service' },
      resource: { type: 'approval', id: approval.id, name: approval.toolName },
      context: {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        workflowRunId: context.workflowRunId,
        nodeRunId: approval.nodeRunId,
      },
      action: {
        type: 'expire',
        previousState: 'PENDING',
        newState: 'EXPIRED',
      },
    });
  }

  /**
   * Log approved action execution
   */
  async logApprovalExecuted(
    approval: {
      id: string;
      nodeRunId: string;
      toolName: string;
    },
    context: {
      tenantId: string;
      workspaceId?: string;
      workflowRunId?: string;
    },
    executionResult: {
      success: boolean;
      error?: string;
    },
  ): Promise<void> {
    await this.log({
      eventType: AuditEventType.APPROVAL_EXECUTED,
      actor: { type: 'agent', id: 'bytebot-agent' },
      resource: { type: 'approval', id: approval.id, name: approval.toolName },
      context: {
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        workflowRunId: context.workflowRunId,
        nodeRunId: approval.nodeRunId,
      },
      action: {
        type: 'execute',
        previousState: 'APPROVED',
        newState: executionResult.success ? 'EXECUTED' : 'FAILED',
      },
      metadata: {
        success: executionResult.success,
        error: executionResult.error,
      },
    });
  }

  /**
   * Log webhook delivery
   */
  async logWebhookDelivery(
    webhook: { id: string; url: string },
    event: { id: string; type: string },
    result: { success: boolean; error?: string; statusCode?: number },
    context: { tenantId: string; approvalId?: string },
  ): Promise<void> {
    await this.log({
      eventType: result.success
        ? AuditEventType.WEBHOOK_SENT
        : AuditEventType.WEBHOOK_FAILED,
      actor: { type: 'system', id: 'webhook-service' },
      resource: { type: 'webhook', id: webhook.id },
      context: {
        tenantId: context.tenantId,
        requestId: event.id,
      },
      action: {
        type: 'deliver',
        newState: result.success ? 'delivered' : 'failed',
      },
      metadata: {
        eventType: event.type,
        webhookUrl: this.maskUrl(webhook.url),
        statusCode: result.statusCode,
        error: result.error,
        approvalId: context.approvalId,
      },
    });
  }

  /**
   * Query audit logs with filtering
   */
  async query(options: AuditLogQuery): Promise<{
    logs: AuditLogEntry[];
    total: number;
  }> {
    const where: any = {
      tenantId: options.tenantId,
    };

    if (options.eventTypes?.length) {
      where.eventType = { in: options.eventTypes };
    }

    if (options.resourceType) {
      where.resourceType = options.resourceType;
    }

    if (options.resourceId) {
      where.resourceId = options.resourceId;
    }

    if (options.actorId) {
      where.actorId = options.actorId;
    }

    if (options.startDate || options.endDate) {
      where.timestamp = {};
      if (options.startDate) {
        where.timestamp.gte = options.startDate;
      }
      if (options.endDate) {
        where.timestamp.lte = options.endDate;
      }
    }

    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      logs: logs.map((l) => this.mapToEntry(l)),
      total,
    };
  }

  /**
   * Get audit trail for a specific approval
   */
  async getApprovalAuditTrail(
    approvalId: string,
    tenantId: string,
  ): Promise<AuditLogEntry[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        resourceType: 'approval',
        resourceId: approvalId,
      },
      orderBy: { timestamp: 'asc' },
    });

    return logs.map((l) => this.mapToEntry(l));
  }

  /**
   * Export audit logs for compliance reporting
   * Returns CSV-formatted data
   */
  async exportLogs(
    options: AuditLogQuery & { format?: 'json' | 'csv' },
  ): Promise<string> {
    const { logs } = await this.query({ ...options, limit: 10000 });

    if (options.format === 'csv') {
      return this.toCSV(logs);
    }

    return JSON.stringify(logs, null, 2);
  }

  /**
   * Cleanup expired audit logs
   * Called by scheduled cleanup service
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.prisma.auditLog.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired audit logs`);
    }

    return result.count;
  }

  /**
   * Get audit log statistics
   */
  async getStats(
    tenantId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<{
    totalEvents: number;
    byEventType: Record<string, number>;
    byResourceType: Record<string, number>;
  }> {
    const where: any = { tenantId };

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) where.timestamp.gte = startDate;
      if (endDate) where.timestamp.lte = endDate;
    }

    const [total, byEventType, byResourceType] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({
        by: ['eventType'],
        where,
        _count: true,
      }),
      this.prisma.auditLog.groupBy({
        by: ['resourceType'],
        where,
        _count: true,
      }),
    ]);

    return {
      totalEvents: total,
      byEventType: byEventType.reduce(
        (acc, item) => ({ ...acc, [item.eventType]: item._count }),
        {},
      ),
      byResourceType: byResourceType.reduce(
        (acc, item) => ({ ...acc, [item.resourceType]: item._count }),
        {},
      ),
    };
  }

  /**
   * Map database record to audit log entry
   */
  private mapToEntry(record: any): AuditLogEntry {
    return {
      id: record.id,
      timestamp: record.timestamp,
      eventType: record.eventType as AuditEventType,
      actor: {
        type: record.actorType,
        id: record.actorId,
        email: record.actorEmail,
        name: record.actorName,
        ipAddress: record.actorIpAddress,
        userAgent: record.actorUserAgent,
      },
      resource: {
        type: record.resourceType,
        id: record.resourceId,
        name: record.resourceName,
      },
      context: {
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        workflowRunId: record.workflowRunId,
        nodeRunId: record.nodeRunId,
        requestId: record.requestId,
      },
      action: {
        type: record.actionType,
        reason: record.actionReason,
        previousState: record.previousState,
        newState: record.newState,
      },
      metadata: record.metadata,
    };
  }

  /**
   * Convert logs to CSV format
   */
  private toCSV(logs: AuditLogEntry[]): string {
    const headers = [
      'timestamp',
      'eventType',
      'actorType',
      'actorId',
      'actorEmail',
      'resourceType',
      'resourceId',
      'tenantId',
      'actionType',
      'actionReason',
      'previousState',
      'newState',
    ];

    const rows = logs.map((log) => [
      log.timestamp.toISOString(),
      log.eventType,
      log.actor.type,
      log.actor.id || '',
      log.actor.email || '',
      log.resource.type,
      log.resource.id,
      log.context.tenantId,
      log.action.type,
      log.action.reason || '',
      log.action.previousState || '',
      log.action.newState || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    return csvContent;
  }

  /**
   * Mask URL for security (hide credentials)
   */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      if (parsed.username) {
        parsed.username = '***';
      }
      return parsed.toString();
    } catch {
      return url.replace(/:[^@]*@/, ':***@');
    }
  }
}
