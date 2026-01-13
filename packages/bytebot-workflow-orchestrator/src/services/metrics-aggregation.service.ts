/**
 * Metrics Aggregation Service
 * v1.0.0: Phase 8 Advanced Analytics Dashboard
 *
 * Pre-aggregates raw metrics into time-bucketed snapshots for efficient
 * dashboard queries. Runs on configurable intervals to create summaries
 * at different granularities (1m, 5m, 1h, 1d).
 *
 * Key responsibilities:
 * - Aggregate workflow execution metrics by time bucket
 * - Calculate percentiles (p50, p95, p99)
 * - Maintain pre-computed aggregates for fast dashboard queries
 * - Clean up old raw metrics (configurable retention)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';

// Aggregation period
export type AggregationPeriod = '1m' | '5m' | '15m' | '1h' | '1d';

// Aggregation result
export interface AggregationResult {
  period: AggregationPeriod;
  bucketStart: Date;
  bucketEnd: Date;
  metricsCreated: number;
}

@Injectable()
export class MetricsAggregationService implements OnModuleInit {
  private readonly logger = new Logger(MetricsAggregationService.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.logger.log('Metrics Aggregation Service initialized');
  }

  /**
   * Aggregate metrics for a specific time period
   */
  async aggregateMetrics(
    period: AggregationPeriod,
    bucketStart: Date,
    bucketEnd: Date,
  ): Promise<AggregationResult> {
    const result: AggregationResult = {
      period,
      bucketStart,
      bucketEnd,
      metricsCreated: 0,
    };

    try {
      // Get distinct tenants with metrics in this period
      const tenants = await this.prisma.workflowExecutionMetric.groupBy({
        by: ['tenantId'],
        where: {
          timestamp: {
            gte: bucketStart,
            lt: bucketEnd,
          },
        },
      });

      for (const tenant of tenants) {
        // Aggregate workflow execution metrics
        const workflowMetrics = await this.aggregateWorkflowMetrics(
          tenant.tenantId,
          period,
          bucketStart,
          bucketEnd,
        );
        result.metricsCreated += workflowMetrics;

        // Aggregate step metrics
        const stepMetrics = await this.aggregateStepMetrics(
          tenant.tenantId,
          period,
          bucketStart,
          bucketEnd,
        );
        result.metricsCreated += stepMetrics;
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to aggregate metrics for ${period}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Aggregate workflow execution metrics for a tenant
   */
  private async aggregateWorkflowMetrics(
    tenantId: string,
    period: AggregationPeriod,
    bucketStart: Date,
    bucketEnd: Date,
  ): Promise<number> {
    // Get all workflow metrics for this period
    const metrics = await this.prisma.workflowExecutionMetric.findMany({
      where: {
        tenantId,
        timestamp: { gte: bucketStart, lt: bucketEnd },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      select: {
        durationMs: true,
        status: true,
      },
    });

    if (metrics.length === 0) return 0;

    // Calculate aggregates
    const durations = metrics
      .filter((m) => m.durationMs !== null)
      .map((m) => m.durationMs!);

    const successCount = metrics.filter((m) => m.status === 'COMPLETED').length;
    const failureCount = metrics.filter((m) => m.status === 'FAILED').length;

    // Calculate percentiles
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p50 = this.getPercentile(sortedDurations, 50);
    const p95 = this.getPercentile(sortedDurations, 95);
    const p99 = this.getPercentile(sortedDurations, 99);

    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = durations.length > 0 ? sum / durations.length : 0;
    const min = durations.length > 0 ? Math.min(...durations) : 0;
    const max = durations.length > 0 ? Math.max(...durations) : 0;

    // Upsert metrics snapshot
    await this.prisma.metricsSnapshot.upsert({
      where: {
        tenantId_metricName_period_bucketStart_workflowId_agentId: {
          tenantId,
          metricName: 'workflow_execution_duration',
          period,
          bucketStart,
          workflowId: '_all',
          agentId: '_all',
        },
      },
      create: {
        tenantId,
        metricName: 'workflow_execution_duration',
        period,
        bucketStart,
        bucketEnd,
        workflowId: '_all',
        agentId: '_all',
        count: metrics.length,
        sum,
        min,
        max,
        avg,
        percentile50: p50,
        percentile95: p95,
        percentile99: p99,
        successCount,
        failureCount,
      },
      update: {
        count: metrics.length,
        sum,
        min,
        max,
        avg,
        percentile50: p50,
        percentile95: p95,
        percentile99: p99,
        successCount,
        failureCount,
      },
    });

    // Also create success rate metric
    const successRate =
      metrics.length > 0 ? (successCount / metrics.length) * 100 : 0;

    await this.prisma.metricsSnapshot.upsert({
      where: {
        tenantId_metricName_period_bucketStart_workflowId_agentId: {
          tenantId,
          metricName: 'workflow_success_rate',
          period,
          bucketStart,
          workflowId: '_all',
          agentId: '_all',
        },
      },
      create: {
        tenantId,
        metricName: 'workflow_success_rate',
        period,
        bucketStart,
        bucketEnd,
        workflowId: '_all',
        agentId: '_all',
        count: metrics.length,
        sum: successRate,
        min: successRate,
        max: successRate,
        avg: successRate,
        percentile50: successRate,
        percentile95: successRate,
        percentile99: successRate,
        successCount,
        failureCount,
      },
      update: {
        count: metrics.length,
        avg: successRate,
        successCount,
        failureCount,
      },
    });

    return 2; // Created/updated 2 metrics
  }

  /**
   * Aggregate step metrics for a tenant
   */
  private async aggregateStepMetrics(
    tenantId: string,
    period: AggregationPeriod,
    bucketStart: Date,
    bucketEnd: Date,
  ): Promise<number> {
    // Get all step metrics for this period
    const metrics = await this.prisma.workflowStepMetric.findMany({
      where: {
        tenantId,
        timestamp: { gte: bucketStart, lt: bucketEnd },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      select: {
        durationMs: true,
        status: true,
      },
    });

    if (metrics.length === 0) return 0;

    // Calculate aggregates
    const durations = metrics
      .filter((m) => m.durationMs !== null)
      .map((m) => m.durationMs!);

    const successCount = metrics.filter((m) => m.status === 'COMPLETED').length;
    const failureCount = metrics.filter((m) => m.status === 'FAILED').length;

    const sortedDurations = [...durations].sort((a, b) => a - b);
    const p50 = this.getPercentile(sortedDurations, 50);
    const p95 = this.getPercentile(sortedDurations, 95);
    const p99 = this.getPercentile(sortedDurations, 99);

    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = durations.length > 0 ? sum / durations.length : 0;
    const min = durations.length > 0 ? Math.min(...durations) : 0;
    const max = durations.length > 0 ? Math.max(...durations) : 0;

    await this.prisma.metricsSnapshot.upsert({
      where: {
        tenantId_metricName_period_bucketStart_workflowId_agentId: {
          tenantId,
          metricName: 'step_execution_duration',
          period,
          bucketStart,
          workflowId: '_all',
          agentId: '_all',
        },
      },
      create: {
        tenantId,
        metricName: 'step_execution_duration',
        period,
        bucketStart,
        bucketEnd,
        workflowId: '_all',
        agentId: '_all',
        count: metrics.length,
        sum,
        min,
        max,
        avg,
        percentile50: p50,
        percentile95: p95,
        percentile99: p99,
        successCount,
        failureCount,
      },
      update: {
        count: metrics.length,
        sum,
        min,
        max,
        avg,
        percentile50: p50,
        percentile95: p95,
        percentile99: p99,
        successCount,
        failureCount,
      },
    });

    return 1;
  }

  /**
   * Calculate percentile from sorted array
   */
  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  /**
   * Get bucket start time for a given timestamp and period
   */
  private getBucketStart(timestamp: Date, period: AggregationPeriod): Date {
    const date = new Date(timestamp);

    switch (period) {
      case '1m':
        date.setSeconds(0, 0);
        break;
      case '5m':
        date.setMinutes(Math.floor(date.getMinutes() / 5) * 5, 0, 0);
        break;
      case '15m':
        date.setMinutes(Math.floor(date.getMinutes() / 15) * 15, 0, 0);
        break;
      case '1h':
        date.setMinutes(0, 0, 0);
        break;
      case '1d':
        date.setHours(0, 0, 0, 0);
        break;
    }

    return date;
  }

  /**
   * Get bucket end time for a given bucket start and period
   */
  private getBucketEnd(bucketStart: Date, period: AggregationPeriod): Date {
    const end = new Date(bucketStart);

    switch (period) {
      case '1m':
        end.setMinutes(end.getMinutes() + 1);
        break;
      case '5m':
        end.setMinutes(end.getMinutes() + 5);
        break;
      case '15m':
        end.setMinutes(end.getMinutes() + 15);
        break;
      case '1h':
        end.setHours(end.getHours() + 1);
        break;
      case '1d':
        end.setDate(end.getDate() + 1);
        break;
    }

    return end;
  }

  // =========================================================================
  // Scheduled Aggregation Jobs
  // =========================================================================

  /**
   * Aggregate 1-minute metrics (runs every minute)
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async aggregate1mMetrics(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = new Date();
      const bucketStart = this.getBucketStart(
        new Date(now.getTime() - 60000),
        '1m',
      );
      const bucketEnd = this.getBucketEnd(bucketStart, '1m');

      const result = await this.aggregateMetrics('1m', bucketStart, bucketEnd);

      if (result.metricsCreated > 0) {
        this.logger.debug(
          `Aggregated ${result.metricsCreated} 1m metrics for ${bucketStart.toISOString()}`,
        );
      }
    } catch (error) {
      this.logger.error(`1m aggregation failed: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Aggregate 5-minute metrics (runs every 5 minutes)
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async aggregate5mMetrics(): Promise<void> {
    try {
      const now = new Date();
      const bucketStart = this.getBucketStart(
        new Date(now.getTime() - 5 * 60000),
        '5m',
      );
      const bucketEnd = this.getBucketEnd(bucketStart, '5m');

      const result = await this.aggregateMetrics('5m', bucketStart, bucketEnd);

      if (result.metricsCreated > 0) {
        this.logger.debug(
          `Aggregated ${result.metricsCreated} 5m metrics for ${bucketStart.toISOString()}`,
        );
      }
    } catch (error) {
      this.logger.error(`5m aggregation failed: ${error.message}`);
    }
  }

  /**
   * Aggregate hourly metrics (runs every hour)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async aggregate1hMetrics(): Promise<void> {
    try {
      const now = new Date();
      const bucketStart = this.getBucketStart(
        new Date(now.getTime() - 60 * 60000),
        '1h',
      );
      const bucketEnd = this.getBucketEnd(bucketStart, '1h');

      const result = await this.aggregateMetrics('1h', bucketStart, bucketEnd);

      if (result.metricsCreated > 0) {
        this.logger.log(
          `Aggregated ${result.metricsCreated} 1h metrics for ${bucketStart.toISOString()}`,
        );
      }
    } catch (error) {
      this.logger.error(`1h aggregation failed: ${error.message}`);
    }
  }

  /**
   * Aggregate daily metrics (runs at midnight)
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async aggregate1dMetrics(): Promise<void> {
    try {
      const now = new Date();
      const bucketStart = this.getBucketStart(
        new Date(now.getTime() - 24 * 60 * 60000),
        '1d',
      );
      const bucketEnd = this.getBucketEnd(bucketStart, '1d');

      const result = await this.aggregateMetrics('1d', bucketStart, bucketEnd);

      if (result.metricsCreated > 0) {
        this.logger.log(
          `Aggregated ${result.metricsCreated} 1d metrics for ${bucketStart.toISOString()}`,
        );
      }
    } catch (error) {
      this.logger.error(`1d aggregation failed: ${error.message}`);
    }
  }

  /**
   * Clean up old raw metrics (runs daily at 2 AM)
   */
  @Cron('0 2 * * *')
  async cleanupOldMetrics(): Promise<void> {
    const retentionDays = this.configService.get<number>(
      'METRICS_RETENTION_DAYS',
      30,
    );

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    try {
      const [deletedWorkflow, deletedStep, deletedSnapshots] =
        await Promise.all([
          this.prisma.workflowExecutionMetric.deleteMany({
            where: { timestamp: { lt: cutoffDate } },
          }),
          this.prisma.workflowStepMetric.deleteMany({
            where: { timestamp: { lt: cutoffDate } },
          }),
          // Keep aggregated snapshots longer (90 days)
          this.prisma.metricsSnapshot.deleteMany({
            where: {
              bucketStart: {
                lt: new Date(
                  cutoffDate.getTime() - 60 * 24 * 60 * 60 * 1000,
                ),
              },
            },
          }),
        ]);

      this.logger.log(
        `Cleaned up old metrics: ${deletedWorkflow.count} workflow, ${deletedStep.count} step, ${deletedSnapshots.count} snapshots`,
      );
    } catch (error) {
      this.logger.error(`Metrics cleanup failed: ${error.message}`);
    }
  }
}
