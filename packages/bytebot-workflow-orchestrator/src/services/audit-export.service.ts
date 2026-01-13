/**
 * Audit Export Service
 * Phase 10 (v5.5.0): Enterprise Features - Enhanced Audit Log Export
 *
 * Provides enterprise-grade audit log export capabilities:
 * - Streaming export for large datasets
 * - Multiple formats (CSV, JSON, NDJSON for SIEM)
 * - Scheduled export jobs
 * - Retention policy enforcement
 * - SIEM integration formats (Splunk, Elasticsearch)
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { Readable } from 'stream';

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum ExportFormat {
  JSON = 'json',
  CSV = 'csv',
  NDJSON = 'ndjson', // Newline-delimited JSON for SIEM
  SPLUNK = 'splunk', // Splunk HEC format
  ELASTICSEARCH = 'elasticsearch', // Elasticsearch bulk format
}

export interface ExportOptions {
  tenantId: string;
  format: ExportFormat;
  startDate?: Date;
  endDate?: Date;
  eventTypes?: string[];
  resourceTypes?: string[];
  actorIds?: string[];
  includeMetadata?: boolean;
  batchSize?: number;
}

export interface ScheduledExportConfig {
  tenantId: string;
  name: string;
  format: ExportFormat;
  schedule: string; // Cron expression
  filters: {
    eventTypes?: string[];
    resourceTypes?: string[];
  };
  destination: {
    type: 'email' | 'webhook' | 's3' | 'azure_blob' | 'gcs';
    config: Record<string, any>;
  };
  retentionDays?: number;
  enabled: boolean;
}

export interface ExportResult {
  success: boolean;
  recordCount: number;
  format: ExportFormat;
  exportedAt: Date;
  sizeBytes?: number;
  downloadUrl?: string;
}

// ============================================================================
// Audit Export Service
// ============================================================================

@Injectable()
export class AuditExportService {
  private readonly logger = new Logger(AuditExportService.name);
  private readonly defaultBatchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.defaultBatchSize = parseInt(
      this.configService.get<string>('AUDIT_EXPORT_BATCH_SIZE', '1000'),
      10,
    );
    this.logger.log('AuditExportService initialized');
  }

  // ==========================================================================
  // Streaming Export
  // ==========================================================================

  /**
   * Create a readable stream for audit log export
   * Handles large datasets efficiently with cursor-based pagination
   */
  createExportStream(options: ExportOptions): Readable {
    const self = this;
    const batchSize = options.batchSize || this.defaultBatchSize;
    let cursor: string | null = null;
    let isFirst = true;
    let recordCount = 0;

    const stream = new Readable({
      objectMode: options.format !== ExportFormat.CSV,
      async read() {
        try {
          const records = await self.fetchBatch(options, batchSize, cursor);

          if (records.length === 0) {
            // End of data
            if (options.format === ExportFormat.JSON) {
              this.push(']');
            }
            this.push(null);
            self.logger.log(`Export complete: ${recordCount} records`);
            return;
          }

          recordCount += records.length;
          cursor = records[records.length - 1].id;

          // Format and push records
          const formatted = self.formatRecords(records, options.format, isFirst);
          this.push(formatted);
          isFirst = false;
        } catch (error: any) {
          self.logger.error(`Export stream error: ${error.message}`);
          this.destroy(error);
        }
      },
    });

    // Write format header
    if (options.format === ExportFormat.JSON) {
      stream.push('[');
    } else if (options.format === ExportFormat.CSV) {
      stream.push(this.getCSVHeader() + '\n');
    }

    return stream;
  }

  /**
   * Export audit logs to a string (for smaller exports)
   */
  async exportToString(options: ExportOptions): Promise<{ data: string; count: number }> {
    const allRecords: any[] = [];
    let cursor: string | null = null;
    const batchSize = options.batchSize || this.defaultBatchSize;

    // Fetch all records
    while (true) {
      const records = await this.fetchBatch(options, batchSize, cursor);
      if (records.length === 0) break;

      allRecords.push(...records);
      cursor = records[records.length - 1].id;

      // Safety limit
      if (allRecords.length > 100000) {
        this.logger.warn('Export limit reached (100k records), consider using streaming');
        break;
      }
    }

    // Format all records
    const formatted = this.formatAllRecords(allRecords, options.format);

    return {
      data: formatted,
      count: allRecords.length,
    };
  }

  // ==========================================================================
  // Format-Specific Methods
  // ==========================================================================

  /**
   * Format records based on export format
   */
  private formatRecords(records: any[], format: ExportFormat, isFirst: boolean): string {
    switch (format) {
      case ExportFormat.JSON:
        const prefix = isFirst ? '' : ',';
        return prefix + records.map(r => JSON.stringify(this.transformRecord(r))).join(',');

      case ExportFormat.CSV:
        return records.map(r => this.toCSVRow(r)).join('\n') + '\n';

      case ExportFormat.NDJSON:
        return records.map(r => JSON.stringify(this.transformRecord(r))).join('\n') + '\n';

      case ExportFormat.SPLUNK:
        return records.map(r => this.toSplunkFormat(r)).join('\n') + '\n';

      case ExportFormat.ELASTICSEARCH:
        return records.map(r => this.toElasticsearchFormat(r)).join('\n') + '\n';

      default:
        return JSON.stringify(records);
    }
  }

  /**
   * Format all records at once (for smaller exports)
   */
  private formatAllRecords(records: any[], format: ExportFormat): string {
    switch (format) {
      case ExportFormat.JSON:
        return JSON.stringify(records.map(r => this.transformRecord(r)), null, 2);

      case ExportFormat.CSV:
        const header = this.getCSVHeader();
        const rows = records.map(r => this.toCSVRow(r));
        return [header, ...rows].join('\n');

      case ExportFormat.NDJSON:
        return records.map(r => JSON.stringify(this.transformRecord(r))).join('\n');

      case ExportFormat.SPLUNK:
        return records.map(r => this.toSplunkFormat(r)).join('\n');

      case ExportFormat.ELASTICSEARCH:
        return records.map(r => this.toElasticsearchFormat(r)).join('\n');

      default:
        return JSON.stringify(records);
    }
  }

  /**
   * Transform database record to export format
   */
  private transformRecord(record: any): any {
    return {
      id: record.id,
      timestamp: record.timestamp.toISOString(),
      eventType: record.eventType,
      actor: {
        type: record.actorType,
        id: record.actorId,
        email: record.actorEmail,
        name: record.actorName,
        ipAddress: record.actorIpAddress,
      },
      resource: {
        type: record.resourceType,
        id: record.resourceId,
        name: record.resourceName,
      },
      action: {
        type: record.actionType,
        reason: record.actionReason,
        previousState: record.previousState,
        newState: record.newState,
      },
      context: {
        tenantId: record.tenantId,
        workspaceId: record.workspaceId,
        workflowRunId: record.workflowRunId,
        nodeRunId: record.nodeRunId,
      },
      metadata: record.metadata,
    };
  }

  /**
   * Get CSV header row
   */
  private getCSVHeader(): string {
    return [
      'id',
      'timestamp',
      'eventType',
      'actorType',
      'actorId',
      'actorEmail',
      'actorName',
      'actorIpAddress',
      'resourceType',
      'resourceId',
      'resourceName',
      'actionType',
      'actionReason',
      'previousState',
      'newState',
      'tenantId',
      'workspaceId',
      'workflowRunId',
    ].join(',');
  }

  /**
   * Convert record to CSV row
   */
  private toCSVRow(record: any): string {
    const escape = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      record.id,
      record.timestamp?.toISOString(),
      record.eventType,
      record.actorType,
      record.actorId,
      record.actorEmail,
      record.actorName,
      record.actorIpAddress,
      record.resourceType,
      record.resourceId,
      record.resourceName,
      record.actionType,
      record.actionReason,
      record.previousState,
      record.newState,
      record.tenantId,
      record.workspaceId,
      record.workflowRunId,
    ].map(escape).join(',');
  }

  /**
   * Convert record to Splunk HEC format
   */
  private toSplunkFormat(record: any): string {
    const event = {
      time: Math.floor(record.timestamp.getTime() / 1000),
      host: 'bytebot-orchestrator',
      source: 'audit-log',
      sourcetype: 'bytebot:audit',
      event: this.transformRecord(record),
    };
    return JSON.stringify(event);
  }

  /**
   * Convert record to Elasticsearch bulk format
   */
  private toElasticsearchFormat(record: any): string {
    const index = `bytebot-audit-${record.timestamp.toISOString().slice(0, 7)}`; // Monthly index
    const action = JSON.stringify({ index: { _index: index, _id: record.id } });
    const doc = JSON.stringify({
      '@timestamp': record.timestamp.toISOString(),
      ...this.transformRecord(record),
    });
    return `${action}\n${doc}`;
  }

  // ==========================================================================
  // Database Operations
  // ==========================================================================

  /**
   * Fetch a batch of audit records with cursor pagination
   */
  private async fetchBatch(
    options: ExportOptions,
    limit: number,
    cursor: string | null,
  ): Promise<any[]> {
    const where: any = {
      tenantId: options.tenantId,
    };

    if (options.startDate || options.endDate) {
      where.timestamp = {};
      if (options.startDate) {
        where.timestamp.gte = options.startDate;
      }
      if (options.endDate) {
        where.timestamp.lte = options.endDate;
      }
    }

    if (options.eventTypes?.length) {
      where.eventType = { in: options.eventTypes };
    }

    if (options.resourceTypes?.length) {
      where.resourceType = { in: options.resourceTypes };
    }

    if (options.actorIds?.length) {
      where.actorId = { in: options.actorIds };
    }

    const queryOptions: any = {
      where,
      take: limit,
      orderBy: { id: 'asc' },
    };

    if (cursor) {
      queryOptions.cursor = { id: cursor };
      queryOptions.skip = 1; // Skip the cursor record
    }

    return this.prisma.auditLog.findMany(queryOptions);
  }

  // ==========================================================================
  // Export Statistics
  // ==========================================================================

  /**
   * Get export statistics for a tenant
   */
  async getExportStats(tenantId: string, days: number = 30): Promise<{
    totalRecords: number;
    recordsByEventType: Record<string, number>;
    recordsByDay: Array<{ date: string; count: number }>;
    estimatedExportSize: { csv: number; json: number };
  }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [total, byEventType, byDay] = await Promise.all([
      this.prisma.auditLog.count({
        where: { tenantId, timestamp: { gte: startDate } },
      }),
      this.prisma.auditLog.groupBy({
        by: ['eventType'],
        where: { tenantId, timestamp: { gte: startDate } },
        _count: true,
      }),
      this.prisma.$queryRaw`
        SELECT DATE(timestamp) as date, COUNT(*)::int as count
        FROM workflow_orchestrator.audit_logs
        WHERE tenant_id = ${tenantId} AND timestamp >= ${startDate}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      ` as Promise<Array<{ date: Date; count: number }>>,
    ]);

    // Estimate export sizes (rough estimates)
    const avgRecordSizeCSV = 300; // bytes
    const avgRecordSizeJSON = 500; // bytes

    return {
      totalRecords: total,
      recordsByEventType: byEventType.reduce(
        (acc, item) => ({ ...acc, [item.eventType]: item._count }),
        {},
      ),
      recordsByDay: byDay.map(d => ({
        date: d.date.toISOString().split('T')[0],
        count: d.count,
      })),
      estimatedExportSize: {
        csv: total * avgRecordSizeCSV,
        json: total * avgRecordSizeJSON,
      },
    };
  }

  // ==========================================================================
  // Retention Management
  // ==========================================================================

  /**
   * Apply retention policy to audit logs
   */
  async applyRetentionPolicy(tenantId: string, retentionDays: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.auditLog.deleteMany({
      where: {
        tenantId,
        timestamp: { lt: cutoffDate },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} audit logs for tenant ${tenantId} (retention: ${retentionDays} days)`);
      this.eventEmitter.emit('audit.retention.applied', {
        tenantId,
        deletedCount: result.count,
        retentionDays,
      });
    }

    return result.count;
  }

  /**
   * Archive old audit logs before deletion
   */
  async archiveBeforeDelete(
    tenantId: string,
    retentionDays: number,
    archiveFormat: ExportFormat = ExportFormat.NDJSON,
  ): Promise<{ archived: number; archiveData: string }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Export records that will be deleted
    const exportResult = await this.exportToString({
      tenantId,
      format: archiveFormat,
      endDate: cutoffDate,
    });

    // Delete the records
    await this.applyRetentionPolicy(tenantId, retentionDays);

    return {
      archived: exportResult.count,
      archiveData: exportResult.data,
    };
  }
}
