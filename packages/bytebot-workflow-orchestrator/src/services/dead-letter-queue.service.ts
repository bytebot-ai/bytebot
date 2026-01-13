/**
 * Dead Letter Queue Service
 * v1.0.1: Phase 9 Self-Healing & Auto-Recovery
 *
 * Manages permanently failed tasks that need manual intervention:
 * - Captures failed tasks after retry exhaustion
 * - Provides manual retry/skip/discard operations
 * - Tracks failure patterns for alerting
 * - Supports bulk operations
 *
 * DLQ entries should be regularly monitored and processed
 * to prevent workflow bottlenecks.
 *
 * v1.0.1 Fix: Use parseInt for ConfigService number values
 * (ConfigService.get<number> only provides TypeScript type hints,
 * not actual runtime type conversion)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { LeaderElectionService } from './leader-election.service';

// DLQ entry status
export enum DLQStatus {
  PENDING = 'PENDING',
  RETRYING = 'RETRYING',
  RESOLVED = 'RESOLVED',
  DISCARDED = 'DISCARDED',
}

// Failure categories
export enum FailureCategory {
  RETRYABLE = 'RETRYABLE',       // Transient failures, can retry
  PERMANENT = 'PERMANENT',       // Permanent failures, needs manual fix
  UNKNOWN = 'UNKNOWN',           // Unclassified failures
}

// Severity levels
export enum DLQSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// DLQ entry summary
export interface DLQEntry {
  id: string;
  tenantId: string;
  workflowRunId: string;
  nodeRunId: string;
  taskType: string;
  failureReason: string;
  failureCount: number;
  failureCategory: FailureCategory;
  severity: DLQSeverity;
  status: DLQStatus;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
  lastFailedAt: Date;
}

// Action result
export interface DLQActionResult {
  id: string;
  success: boolean;
  action: 'RETRY' | 'SKIP' | 'DISCARD';
  error?: string;
}

// DLQ statistics
export interface DLQStats {
  total: number;
  pending: number;
  retrying: number;
  resolved: number;
  discarded: number;
  bySeverity: Record<DLQSeverity, number>;
  byCategory: Record<FailureCategory, number>;
  avgResolutionTimeMs: number;
}

@Injectable()
export class DeadLetterQueueService implements OnModuleInit {
  private readonly logger = new Logger(DeadLetterQueueService.name);

  // Configuration
  private readonly autoRetryEnabled: boolean;
  private readonly autoRetryMaxAttempts: number;
  private readonly autoRetryDelayMs: number;
  private readonly alertThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly leaderElection: LeaderElectionService,
  ) {
    // v1.0.1: Use string comparison for boolean env vars (env vars are always strings)
    this.autoRetryEnabled =
      this.configService.get<string>('DLQ_AUTO_RETRY_ENABLED', 'false') === 'true';

    // v1.0.1: Use parseInt for numeric env vars to ensure actual number type
    this.autoRetryMaxAttempts = parseInt(
      this.configService.get<string>('DLQ_AUTO_RETRY_MAX_ATTEMPTS', '3'),
      10,
    );
    this.autoRetryDelayMs = parseInt(
      this.configService.get<string>('DLQ_AUTO_RETRY_DELAY_MS', '300000'), // 5 minutes
      10,
    );
    this.alertThreshold = parseInt(
      this.configService.get<string>('DLQ_ALERT_THRESHOLD', '10'),
      10,
    );
  }

  onModuleInit() {
    this.logger.log(
      `Dead Letter Queue Service initialized (autoRetry: ${this.autoRetryEnabled}, ` +
      `alertThreshold: ${this.alertThreshold})`,
    );
  }

  /**
   * Add an entry to the DLQ
   */
  async addEntry(params: {
    tenantId: string;
    workflowRunId: string;
    nodeRunId: string;
    taskType: string;
    originalPayload: any;
    failureReason: string;
    errorDetails?: any;
    failureCategory?: FailureCategory;
    severity?: DLQSeverity;
  }): Promise<string> {
    const entry = await this.prisma.deadLetterEntry.create({
      data: {
        tenantId: params.tenantId,
        workflowRunId: params.workflowRunId,
        nodeRunId: params.nodeRunId,
        taskType: params.taskType,
        originalPayload: params.originalPayload,
        failureReason: params.failureReason,
        lastFailedAt: new Date(),
        errorDetails: params.errorDetails ?? {},
        failureCategory: params.failureCategory ?? FailureCategory.UNKNOWN,
        severity: params.severity ?? DLQSeverity.HIGH,
        status: DLQStatus.PENDING,
        maxRetries: this.autoRetryMaxAttempts,
        nextRetryAt: this.autoRetryEnabled
          ? new Date(Date.now() + this.autoRetryDelayMs)
          : null,
      },
    });

    this.logger.log(
      `Added DLQ entry ${entry.id} for node run ${params.nodeRunId}: ${params.failureReason}`,
    );

    this.eventEmitter.emit('dlq.entry-added', {
      id: entry.id,
      tenantId: params.tenantId,
      workflowRunId: params.workflowRunId,
      nodeRunId: params.nodeRunId,
      severity: params.severity ?? DLQSeverity.HIGH,
    });

    // Check if alert threshold exceeded
    await this.checkAlertThreshold(params.tenantId);

    return entry.id;
  }

  /**
   * Get DLQ entries with filtering
   */
  async getEntries(params: {
    tenantId?: string;
    status?: DLQStatus;
    severity?: DLQSeverity;
    category?: FailureCategory;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: DLQEntry[]; total: number }> {
    const where: any = {};

    if (params.tenantId) {
      where.tenantId = params.tenantId;
    }
    if (params.status) {
      where.status = params.status;
    }
    if (params.severity) {
      where.severity = params.severity;
    }
    if (params.category) {
      where.failureCategory = params.category;
    }

    const [entries, total] = await Promise.all([
      this.prisma.deadLetterEntry.findMany({
        where,
        orderBy: [
          { severity: 'desc' },
          { createdAt: 'desc' },
        ],
        take: params.limit ?? 50,
        skip: params.offset ?? 0,
      }),
      this.prisma.deadLetterEntry.count({ where }),
    ]);

    return {
      entries: entries.map((e) => ({
        id: e.id,
        tenantId: e.tenantId,
        workflowRunId: e.workflowRunId,
        nodeRunId: e.nodeRunId,
        taskType: e.taskType,
        failureReason: e.failureReason,
        failureCount: e.failureCount,
        failureCategory: e.failureCategory as FailureCategory,
        severity: e.severity as DLQSeverity,
        status: e.status as DLQStatus,
        retryCount: e.retryCount,
        maxRetries: e.maxRetries,
        createdAt: e.createdAt,
        lastFailedAt: e.lastFailedAt,
      })),
      total,
    };
  }

  /**
   * Get a single DLQ entry by ID
   */
  async getEntry(id: string): Promise<DLQEntry | null> {
    const entry = await this.prisma.deadLetterEntry.findUnique({
      where: { id },
    });

    if (!entry) {
      return null;
    }

    return {
      id: entry.id,
      tenantId: entry.tenantId,
      workflowRunId: entry.workflowRunId,
      nodeRunId: entry.nodeRunId,
      taskType: entry.taskType,
      failureReason: entry.failureReason,
      failureCount: entry.failureCount,
      failureCategory: entry.failureCategory as FailureCategory,
      severity: entry.severity as DLQSeverity,
      status: entry.status as DLQStatus,
      retryCount: entry.retryCount,
      maxRetries: entry.maxRetries,
      createdAt: entry.createdAt,
      lastFailedAt: entry.lastFailedAt,
    };
  }

  /**
   * Retry a DLQ entry
   */
  async retryEntry(
    id: string,
    userId?: string,
  ): Promise<DLQActionResult> {
    try {
      const entry = await this.prisma.deadLetterEntry.findUnique({
        where: { id },
      });

      if (!entry) {
        return { id, success: false, action: 'RETRY', error: 'Entry not found' };
      }

      if (entry.status !== DLQStatus.PENDING) {
        return {
          id,
          success: false,
          action: 'RETRY',
          error: `Cannot retry entry in ${entry.status} status`,
        };
      }

      // Update entry to retrying
      await this.prisma.deadLetterEntry.update({
        where: { id },
        data: {
          status: DLQStatus.RETRYING,
          retryCount: entry.retryCount + 1,
        },
      });

      // Reset the node run to allow re-execution
      await this.prisma.workflowNodeRun.update({
        where: { id: entry.nodeRunId },
        data: {
          status: 'PENDING',
          error: null,
        },
      });

      // Log recovery action
      await this.logRecoveryAction(
        entry.tenantId,
        entry.nodeRunId,
        'DLQ_RETRY',
        'FAILED',
        'PENDING',
        `Manual retry from DLQ (attempt ${entry.retryCount + 1})`,
        true,
        userId,
      );

      this.logger.log(
        `DLQ entry ${id} marked for retry (attempt ${entry.retryCount + 1})`,
      );

      this.eventEmitter.emit('dlq.entry-retried', {
        id,
        nodeRunId: entry.nodeRunId,
        attempt: entry.retryCount + 1,
      });

      return { id, success: true, action: 'RETRY' };
    } catch (error) {
      return { id, success: false, action: 'RETRY', error: error.message };
    }
  }

  /**
   * Skip a DLQ entry (mark node as skipped, continue workflow)
   */
  async skipEntry(
    id: string,
    reason: string,
    userId?: string,
  ): Promise<DLQActionResult> {
    try {
      const entry = await this.prisma.deadLetterEntry.findUnique({
        where: { id },
      });

      if (!entry) {
        return { id, success: false, action: 'SKIP', error: 'Entry not found' };
      }

      if (entry.status !== DLQStatus.PENDING) {
        return {
          id,
          success: false,
          action: 'SKIP',
          error: `Cannot skip entry in ${entry.status} status`,
        };
      }

      // Update entry as resolved
      await this.prisma.deadLetterEntry.update({
        where: { id },
        data: {
          status: DLQStatus.RESOLVED,
          resolvedAt: new Date(),
          resolvedBy: userId,
          resolutionNote: `Skipped: ${reason}`,
        },
      });

      // Mark node run as skipped
      await this.prisma.workflowNodeRun.update({
        where: { id: entry.nodeRunId },
        data: {
          status: 'SKIPPED',
          error: `Skipped via DLQ: ${reason}`,
          completedAt: new Date(),
        },
      });

      // Log recovery action
      await this.logRecoveryAction(
        entry.tenantId,
        entry.nodeRunId,
        'DLQ_SKIP',
        'FAILED',
        'SKIPPED',
        reason,
        true,
        userId,
      );

      this.logger.log(`DLQ entry ${id} skipped: ${reason}`);

      this.eventEmitter.emit('dlq.entry-skipped', {
        id,
        nodeRunId: entry.nodeRunId,
        reason,
      });

      return { id, success: true, action: 'SKIP' };
    } catch (error) {
      return { id, success: false, action: 'SKIP', error: error.message };
    }
  }

  /**
   * Discard a DLQ entry (abandon permanently)
   */
  async discardEntry(
    id: string,
    reason: string,
    userId?: string,
  ): Promise<DLQActionResult> {
    try {
      const entry = await this.prisma.deadLetterEntry.findUnique({
        where: { id },
      });

      if (!entry) {
        return { id, success: false, action: 'DISCARD', error: 'Entry not found' };
      }

      if (entry.status !== DLQStatus.PENDING) {
        return {
          id,
          success: false,
          action: 'DISCARD',
          error: `Cannot discard entry in ${entry.status} status`,
        };
      }

      // Update entry as discarded
      await this.prisma.deadLetterEntry.update({
        where: { id },
        data: {
          status: DLQStatus.DISCARDED,
          resolvedAt: new Date(),
          resolvedBy: userId,
          resolutionNote: `Discarded: ${reason}`,
        },
      });

      // Mark node run as permanently failed
      await this.prisma.workflowNodeRun.update({
        where: { id: entry.nodeRunId },
        data: {
          status: 'FAILED',
          error: `Discarded via DLQ: ${reason}`,
          completedAt: new Date(),
        },
      });

      // Log recovery action
      await this.logRecoveryAction(
        entry.tenantId,
        entry.nodeRunId,
        'DLQ_DISCARD',
        'PENDING',
        'DISCARDED',
        reason,
        true,
        userId,
      );

      this.logger.log(`DLQ entry ${id} discarded: ${reason}`);

      this.eventEmitter.emit('dlq.entry-discarded', {
        id,
        nodeRunId: entry.nodeRunId,
        reason,
      });

      return { id, success: true, action: 'DISCARD' };
    } catch (error) {
      return { id, success: false, action: 'DISCARD', error: error.message };
    }
  }

  /**
   * Bulk retry entries
   */
  async bulkRetry(
    ids: string[],
    userId?: string,
  ): Promise<DLQActionResult[]> {
    const results: DLQActionResult[] = [];

    for (const id of ids) {
      const result = await this.retryEntry(id, userId);
      results.push(result);
    }

    return results;
  }

  /**
   * Bulk skip entries
   */
  async bulkSkip(
    ids: string[],
    reason: string,
    userId?: string,
  ): Promise<DLQActionResult[]> {
    const results: DLQActionResult[] = [];

    for (const id of ids) {
      const result = await this.skipEntry(id, reason, userId);
      results.push(result);
    }

    return results;
  }

  /**
   * Get DLQ statistics
   */
  async getStats(tenantId?: string): Promise<DLQStats> {
    const where = tenantId ? { tenantId } : {};

    const [total, pending, retrying, resolved, discarded] = await Promise.all([
      this.prisma.deadLetterEntry.count({ where }),
      this.prisma.deadLetterEntry.count({
        where: { ...where, status: DLQStatus.PENDING },
      }),
      this.prisma.deadLetterEntry.count({
        where: { ...where, status: DLQStatus.RETRYING },
      }),
      this.prisma.deadLetterEntry.count({
        where: { ...where, status: DLQStatus.RESOLVED },
      }),
      this.prisma.deadLetterEntry.count({
        where: { ...where, status: DLQStatus.DISCARDED },
      }),
    ]);

    // Get counts by severity
    const bySeverity: Record<DLQSeverity, number> = {
      [DLQSeverity.LOW]: 0,
      [DLQSeverity.MEDIUM]: 0,
      [DLQSeverity.HIGH]: 0,
      [DLQSeverity.CRITICAL]: 0,
    };

    const severityCounts = await this.prisma.deadLetterEntry.groupBy({
      by: ['severity'],
      where: { ...where, status: DLQStatus.PENDING },
      _count: true,
    });

    for (const sc of severityCounts) {
      bySeverity[sc.severity as DLQSeverity] = sc._count;
    }

    // Get counts by category
    const byCategory: Record<FailureCategory, number> = {
      [FailureCategory.RETRYABLE]: 0,
      [FailureCategory.PERMANENT]: 0,
      [FailureCategory.UNKNOWN]: 0,
    };

    const categoryCounts = await this.prisma.deadLetterEntry.groupBy({
      by: ['failureCategory'],
      where: { ...where, status: DLQStatus.PENDING },
      _count: true,
    });

    for (const cc of categoryCounts) {
      byCategory[cc.failureCategory as FailureCategory] = cc._count;
    }

    // Calculate average resolution time
    const resolvedEntries = await this.prisma.deadLetterEntry.findMany({
      where: {
        ...where,
        status: { in: [DLQStatus.RESOLVED, DLQStatus.DISCARDED] },
        resolvedAt: { not: null },
      },
      select: {
        createdAt: true,
        resolvedAt: true,
      },
      take: 100,
      orderBy: { resolvedAt: 'desc' },
    });

    let avgResolutionTimeMs = 0;
    if (resolvedEntries.length > 0) {
      const totalMs = resolvedEntries.reduce((sum, e) => {
        return sum + (e.resolvedAt!.getTime() - e.createdAt.getTime());
      }, 0);
      avgResolutionTimeMs = Math.round(totalMs / resolvedEntries.length);
    }

    return {
      total,
      pending,
      retrying,
      resolved,
      discarded,
      bySeverity,
      byCategory,
      avgResolutionTimeMs,
    };
  }

  /**
   * Process auto-retry entries (runs every 5 minutes)
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async processAutoRetries(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      return;
    }

    if (!this.autoRetryEnabled) {
      return;
    }

    try {
      const entriesToRetry = await this.prisma.deadLetterEntry.findMany({
        where: {
          status: DLQStatus.PENDING,
          failureCategory: FailureCategory.RETRYABLE,
          retryCount: { lt: this.autoRetryMaxAttempts },
          nextRetryAt: { lte: new Date() },
        },
        take: 10,
      });

      for (const entry of entriesToRetry) {
        await this.retryEntry(entry.id, 'SYSTEM_AUTO_RETRY');
      }

      if (entriesToRetry.length > 0) {
        this.logger.log(
          `Auto-retried ${entriesToRetry.length} DLQ entries`,
        );
      }
    } catch (error) {
      this.logger.error(`Auto-retry processing failed: ${error.message}`);
    }
  }

  /**
   * Handle retry completion callback
   */
  async handleRetryComplete(
    nodeRunId: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const entry = await this.prisma.deadLetterEntry.findFirst({
      where: {
        nodeRunId,
        status: DLQStatus.RETRYING,
      },
    });

    if (!entry) {
      return;
    }

    if (success) {
      // Mark as resolved
      await this.prisma.deadLetterEntry.update({
        where: { id: entry.id },
        data: {
          status: DLQStatus.RESOLVED,
          resolvedAt: new Date(),
          resolutionNote: 'Retry successful',
        },
      });

      this.logger.log(`DLQ entry ${entry.id} resolved after retry`);

      this.eventEmitter.emit('dlq.entry-resolved', {
        id: entry.id,
        nodeRunId,
      });
    } else {
      // Handle retry failure
      if (entry.retryCount >= entry.maxRetries) {
        // Max retries exceeded, mark as permanent
        await this.prisma.deadLetterEntry.update({
          where: { id: entry.id },
          data: {
            status: DLQStatus.PENDING,
            failureCategory: FailureCategory.PERMANENT,
            failureReason: `${entry.failureReason} (retry failed: ${error})`,
            failureCount: entry.failureCount + 1,
            lastFailedAt: new Date(),
          },
        });

        this.logger.warn(
          `DLQ entry ${entry.id} marked as permanent after ${entry.retryCount} retries`,
        );
      } else {
        // Schedule next retry
        await this.prisma.deadLetterEntry.update({
          where: { id: entry.id },
          data: {
            status: DLQStatus.PENDING,
            failureCount: entry.failureCount + 1,
            lastFailedAt: new Date(),
            nextRetryAt: new Date(Date.now() + this.autoRetryDelayMs),
            errorDetails: {
              ...(entry.errorDetails as any),
              [`retry_${entry.retryCount}`]: error,
            },
          },
        });
      }
    }
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Check if alert threshold is exceeded
   */
  private async checkAlertThreshold(tenantId: string): Promise<void> {
    const pendingCount = await this.prisma.deadLetterEntry.count({
      where: {
        tenantId,
        status: DLQStatus.PENDING,
      },
    });

    if (pendingCount >= this.alertThreshold) {
      this.logger.warn(
        `DLQ alert threshold exceeded for tenant ${tenantId}: ${pendingCount} pending entries`,
      );

      this.eventEmitter.emit('dlq.threshold-exceeded', {
        tenantId,
        count: pendingCount,
        threshold: this.alertThreshold,
      });
    }
  }

  /**
   * Log a recovery action
   */
  private async logRecoveryAction(
    tenantId: string,
    targetId: string,
    actionType: string,
    previousState: string,
    newState: string,
    reason: string,
    success: boolean,
    actorId?: string,
  ): Promise<void> {
    try {
      await this.prisma.recoveryLog.create({
        data: {
          tenantId,
          actionType,
          targetType: 'NODE',
          targetId,
          previousState,
          newState,
          reason,
          actorType: actorId?.startsWith('SYSTEM') ? 'SYSTEM' : 'USER',
          actorId,
          success,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log recovery action: ${error.message}`);
    }
  }
}
