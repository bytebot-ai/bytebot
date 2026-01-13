/**
 * Audit Controller
 * Post-M5 Enhancement: API endpoints for querying audit logs
 *
 * Endpoints:
 * - GET  /api/v1/audit                List audit logs with filtering
 * - GET  /api/v1/audit/approvals/:id  Get audit trail for specific approval
 * - GET  /api/v1/audit/export         Export audit logs (CSV/JSON)
 * - GET  /api/v1/audit/stats          Get audit log statistics
 */

import {
  Controller,
  Get,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  Headers,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { AuditService, AuditEventType } from '../services/audit.service';

/**
 * Query parameters for listing audit logs
 */
interface ListAuditLogsQuery {
  eventTypes?: string;
  resourceType?: string;
  resourceId?: string;
  actorId?: string;
  startDate?: string;
  endDate?: string;
  limit?: string;
  offset?: string;
}

/**
 * Query parameters for export
 */
interface ExportQuery extends ListAuditLogsQuery {
  format?: 'json' | 'csv';
}

/**
 * Query parameters for stats
 */
interface StatsQuery {
  startDate?: string;
  endDate?: string;
}

@Controller('audit')
export class AuditController {
  private readonly logger = new Logger(AuditController.name);

  constructor(private readonly auditService: AuditService) {}

  /**
   * GET /api/v1/audit
   * List audit logs with filtering
   */
  @Get()
  async listAuditLogs(
    @Query() query: ListAuditLogsQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const limit = parseInt(query.limit || '50', 10);
    const offset = parseInt(query.offset || '0', 10);

    // Parse event types if provided
    let eventTypes: AuditEventType[] | undefined;
    if (query.eventTypes) {
      eventTypes = query.eventTypes.split(',') as AuditEventType[];
      // Validate event types
      const validTypes = Object.values(AuditEventType);
      const invalidTypes = eventTypes.filter((t) => !validTypes.includes(t));
      if (invalidTypes.length > 0) {
        throw new HttpException(
          `Invalid event types: ${invalidTypes.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Parse dates if provided
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (query.startDate) {
      startDate = new Date(query.startDate);
      if (isNaN(startDate.getTime())) {
        throw new HttpException('Invalid startDate format', HttpStatus.BAD_REQUEST);
      }
    }

    if (query.endDate) {
      endDate = new Date(query.endDate);
      if (isNaN(endDate.getTime())) {
        throw new HttpException('Invalid endDate format', HttpStatus.BAD_REQUEST);
      }
    }

    try {
      const { logs, total } = await this.auditService.query({
        tenantId,
        eventTypes,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        actorId: query.actorId,
        startDate,
        endDate,
        limit,
        offset,
      });

      return {
        success: true,
        logs: logs.map((log) => this.formatAuditLog(log)),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + logs.length < total,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to query audit logs: ${error.message}`);
      throw new HttpException(
        `Failed to query audit logs: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/audit/approvals/:id
   * Get audit trail for a specific approval
   */
  @Get('approvals/:id')
  async getApprovalAuditTrail(
    @Param('id') approvalId: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    try {
      const logs = await this.auditService.getApprovalAuditTrail(approvalId, tenantId);

      return {
        success: true,
        approvalId,
        auditTrail: logs.map((log) => this.formatAuditLog(log)),
        summary: this.generateAuditSummary(logs),
      };
    } catch (error: any) {
      this.logger.error(`Failed to get approval audit trail: ${error.message}`);
      throw new HttpException(
        `Failed to get audit trail: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/audit/export
   * Export audit logs in CSV or JSON format
   */
  @Get('export')
  async exportAuditLogs(
    @Query() query: ExportQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
    @Res() res?: Response,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const format = query.format || 'json';

    // Parse event types if provided
    let eventTypes: AuditEventType[] | undefined;
    if (query.eventTypes) {
      eventTypes = query.eventTypes.split(',') as AuditEventType[];
    }

    // Parse dates if provided
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (query.startDate) {
      startDate = new Date(query.startDate);
    }

    if (query.endDate) {
      endDate = new Date(query.endDate);
    }

    try {
      const data = await this.auditService.exportLogs({
        tenantId,
        eventTypes,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        actorId: query.actorId,
        startDate,
        endDate,
        format,
      });

      // Set response headers for download
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `audit-logs-${timestamp}.${format}`;

      if (res) {
        res.setHeader('Content-Type', format === 'csv' ? 'text/csv' : 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(data);
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error(`Failed to export audit logs: ${error.message}`);
      throw new HttpException(
        `Failed to export audit logs: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/audit/stats
   * Get audit log statistics
   */
  @Get('stats')
  async getStats(
    @Query() query: StatsQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Parse dates if provided
    let startDate: Date | undefined;
    let endDate: Date | undefined;

    if (query.startDate) {
      startDate = new Date(query.startDate);
      if (isNaN(startDate.getTime())) {
        throw new HttpException('Invalid startDate format', HttpStatus.BAD_REQUEST);
      }
    }

    if (query.endDate) {
      endDate = new Date(query.endDate);
      if (isNaN(endDate.getTime())) {
        throw new HttpException('Invalid endDate format', HttpStatus.BAD_REQUEST);
      }
    }

    try {
      const stats = await this.auditService.getStats(tenantId, startDate, endDate);

      return {
        success: true,
        stats: {
          ...stats,
          dateRange: {
            start: startDate?.toISOString() || 'all time',
            end: endDate?.toISOString() || 'now',
          },
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to get audit stats: ${error.message}`);
      throw new HttpException(
        `Failed to get audit stats: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/audit/event-types
   * Get available audit event types
   */
  @Get('event-types')
  getEventTypes() {
    return {
      success: true,
      eventTypes: Object.values(AuditEventType).map((type) => ({
        type,
        description: this.getEventDescription(type),
        category: this.getEventCategory(type),
      })),
    };
  }

  /**
   * Format audit log entry for response
   */
  private formatAuditLog(log: any) {
    return {
      id: log.id,
      timestamp: log.timestamp,
      eventType: log.eventType,
      actor: {
        type: log.actor.type,
        id: log.actor.id,
        email: log.actor.email,
        name: log.actor.name,
      },
      resource: {
        type: log.resource.type,
        id: log.resource.id,
        name: log.resource.name,
      },
      action: {
        type: log.action.type,
        reason: log.action.reason,
        previousState: log.action.previousState,
        newState: log.action.newState,
      },
      context: {
        workflowRunId: log.context.workflowRunId,
        nodeRunId: log.context.nodeRunId,
      },
    };
  }

  /**
   * Generate summary of audit trail
   */
  private generateAuditSummary(logs: any[]) {
    if (logs.length === 0) {
      return { totalEvents: 0 };
    }

    const firstEvent = logs[0];
    const lastEvent = logs[logs.length - 1];

    return {
      totalEvents: logs.length,
      firstEvent: {
        type: firstEvent.eventType,
        timestamp: firstEvent.timestamp,
      },
      lastEvent: {
        type: lastEvent.eventType,
        timestamp: lastEvent.timestamp,
      },
      eventTypes: [...new Set(logs.map((l) => l.eventType))],
      actors: [...new Set(logs.map((l) => l.actor.id).filter(Boolean))],
    };
  }

  /**
   * Get human-readable event description
   */
  private getEventDescription(eventType: AuditEventType): string {
    const descriptions: Record<AuditEventType, string> = {
      [AuditEventType.APPROVAL_REQUESTED]: 'A high-risk action requested approval',
      [AuditEventType.APPROVAL_VIEWED]: 'An approver viewed the approval request',
      [AuditEventType.APPROVAL_APPROVED]: 'The action was approved',
      [AuditEventType.APPROVAL_REJECTED]: 'The action was rejected',
      [AuditEventType.APPROVAL_EXPIRED]: 'The approval request expired',
      [AuditEventType.APPROVAL_EXECUTED]: 'The approved action was executed',
      [AuditEventType.WEBHOOK_SENT]: 'A webhook notification was delivered',
      [AuditEventType.WEBHOOK_FAILED]: 'A webhook notification failed',
      [AuditEventType.USER_PROMPT_CREATED]: 'An external input request was created',
      [AuditEventType.USER_PROMPT_RESOLVED]: 'An external input request was resolved',
      [AuditEventType.USER_PROMPT_CANCELLED]: 'An external input request was cancelled',
      [AuditEventType.USER_PROMPT_EXPIRED]: 'An external input request expired',
      [AuditEventType.WEBHOOK_CREATED]: 'A webhook configuration was created',
      [AuditEventType.WEBHOOK_UPDATED]: 'A webhook configuration was updated',
      [AuditEventType.WEBHOOK_DELETED]: 'A webhook configuration was deleted',
      [AuditEventType.WEBHOOK_SECRET_ROTATED]: 'A webhook secret was rotated',
    };
    return descriptions[eventType] || 'Unknown event type';
  }

  /**
   * Get event category for grouping
   */
  private getEventCategory(eventType: AuditEventType): string {
    if (eventType.startsWith('APPROVAL_')) {
      return 'approval';
    }
    if (eventType.startsWith('USER_PROMPT_')) {
      return 'prompt';
    }
    if (eventType.startsWith('WEBHOOK_')) {
      return 'webhook';
    }
    return 'other';
  }
}
