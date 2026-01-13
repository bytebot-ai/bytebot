/**
 * Analytics Query Service
 * v2.0.0: Phase 7 Enhanced Features - Goal Run Analytics
 *
 * Provides optimized queries for dashboard visualization and analytics.
 * Uses pre-aggregated metrics snapshots for fast queries at scale.
 *
 * Key responsibilities:
 * - Time-series data retrieval for charts
 * - KPI calculations
 * - Comparative analysis (period-over-period)
 * - Top-N rankings (workflows, agents, etc.)
 * - Goal run execution insights (Phase 7)
 * - Template analytics (Phase 7)
 * - Batch execution analytics (Phase 7)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { AggregationPeriod } from './metrics-aggregation.service';

// Time range presets
export enum TimeRange {
  LAST_HOUR = '1h',
  LAST_6_HOURS = '6h',
  LAST_24_HOURS = '24h',
  LAST_7_DAYS = '7d',
  LAST_30_DAYS = '30d',
  CUSTOM = 'custom',
}

// KPI summary result
export interface KPISummary {
  totalExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  totalSteps: number;
  avgStepsPerWorkflow: number;
  activeAgents: number;
}

// Time-series data point
export interface TimeSeriesPoint {
  timestamp: Date;
  value: number;
  metadata?: Record<string, any>;
}

// Dashboard summary
export interface DashboardSummary {
  kpis: KPISummary;
  trends: {
    executionsTrend: TimeSeriesPoint[];
    successRateTrend: TimeSeriesPoint[];
    durationTrend: TimeSeriesPoint[];
  };
  topWorkflows: Array<{
    workflowName: string;
    count: number;
    successRate: number;
    avgDurationMs: number;
  }>;
  topAgents: Array<{
    agentId: string;
    agentName: string;
    tasksCompleted: number;
    avgDurationMs: number;
  }>;
  recentErrors: Array<{
    workflowRunId: string;
    workflowName: string;
    errorType: string | null;
    errorMessage: string | null;
    timestamp: Date;
  }>;
}

@Injectable()
export class AnalyticsQueryService {
  private readonly logger = new Logger(AnalyticsQueryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get KPI summary for a tenant
   */
  async getKPISummary(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<KPISummary> {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );

    // Get workflow execution aggregates
    const workflowStats = await this.prisma.workflowExecutionMetric.aggregate({
      where: {
        tenantId,
        timestamp: { gte: start, lte: end },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      _count: true,
      _avg: { durationMs: true, nodeCount: true },
    });

    // Get success/failure counts
    const statusCounts = await this.prisma.workflowExecutionMetric.groupBy({
      by: ['status'],
      where: {
        tenantId,
        timestamp: { gte: start, lte: end },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      _count: true,
    });

    // Get percentiles from recent snapshot
    const latestSnapshot = await this.prisma.metricsSnapshot.findFirst({
      where: {
        tenantId,
        metricName: 'workflow_execution_duration',
        bucketStart: { gte: start },
      },
      orderBy: { bucketStart: 'desc' },
    });

    // Get step counts
    const stepStats = await this.prisma.workflowStepMetric.aggregate({
      where: {
        tenantId,
        timestamp: { gte: start, lte: end },
      },
      _count: true,
    });

    // Get active agents count
    const activeAgents = await this.prisma.agent.count({
      where: {
        status: { in: ['HEALTHY', 'STARTING'] },
      },
    });

    const completed =
      statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
    const failed = statusCounts.find((s) => s.status === 'FAILED')?._count ?? 0;
    const total = completed + failed;

    return {
      totalExecutions: total,
      completedExecutions: completed,
      failedExecutions: failed,
      successRate: total > 0 ? (completed / total) * 100 : 0,
      avgDurationMs: workflowStats._avg?.durationMs ?? 0,
      p50DurationMs: latestSnapshot?.percentile50 ?? 0,
      p95DurationMs: latestSnapshot?.percentile95 ?? 0,
      p99DurationMs: latestSnapshot?.percentile99 ?? 0,
      totalSteps: stepStats._count ?? 0,
      avgStepsPerWorkflow: workflowStats._avg?.nodeCount ?? 0,
      activeAgents,
    };
  }

  /**
   * Get time-series data for a metric
   */
  async getTimeSeries(
    tenantId: string,
    metricName: string,
    timeRange: TimeRange,
    period: AggregationPeriod = '5m',
    customStart?: Date,
    customEnd?: Date,
  ): Promise<TimeSeriesPoint[]> {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );

    const snapshots = await this.prisma.metricsSnapshot.findMany({
      where: {
        tenantId,
        metricName,
        period,
        bucketStart: { gte: start, lte: end },
      },
      orderBy: { bucketStart: 'asc' },
      select: {
        bucketStart: true,
        avg: true,
        count: true,
        successCount: true,
        failureCount: true,
      },
    });

    return snapshots.map((s) => ({
      timestamp: s.bucketStart,
      value: s.avg,
      metadata: {
        count: s.count,
        successCount: s.successCount,
        failureCount: s.failureCount,
      },
    }));
  }

  /**
   * Get execution trends (count over time)
   */
  async getExecutionTrends(
    tenantId: string,
    timeRange: TimeRange,
    period: AggregationPeriod = '1h',
    customStart?: Date,
    customEnd?: Date,
  ): Promise<TimeSeriesPoint[]> {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );

    const snapshots = await this.prisma.metricsSnapshot.findMany({
      where: {
        tenantId,
        metricName: 'workflow_execution_duration',
        period,
        bucketStart: { gte: start, lte: end },
      },
      orderBy: { bucketStart: 'asc' },
      select: {
        bucketStart: true,
        count: true,
        successCount: true,
        failureCount: true,
      },
    });

    return snapshots.map((s) => ({
      timestamp: s.bucketStart,
      value: s.count,
      metadata: {
        successCount: s.successCount,
        failureCount: s.failureCount,
      },
    }));
  }

  /**
   * Get top workflows by execution count
   */
  async getTopWorkflows(
    tenantId: string,
    timeRange: TimeRange,
    limit: number = 10,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<
    Array<{
      workflowName: string;
      templateId: string | null;
      count: number;
      successCount: number;
      failureCount: number;
      successRate: number;
      avgDurationMs: number;
    }>
  > {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );

    const workflows = await this.prisma.workflowExecutionMetric.groupBy({
      by: ['workflowName', 'templateId'],
      where: {
        tenantId,
        timestamp: { gte: start, lte: end },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      _count: true,
      _avg: { durationMs: true },
    });

    // Get success/failure breakdowns
    const results = await Promise.all(
      workflows.slice(0, limit * 2).map(async (w) => {
        const statusCounts =
          await this.prisma.workflowExecutionMetric.groupBy({
            by: ['status'],
            where: {
              tenantId,
              workflowName: w.workflowName,
              timestamp: { gte: start, lte: end },
              status: { in: ['COMPLETED', 'FAILED'] },
            },
            _count: true,
          });

        const successCount =
          statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
        const failureCount =
          statusCounts.find((s) => s.status === 'FAILED')?._count ?? 0;
        const total = successCount + failureCount;

        return {
          workflowName: w.workflowName,
          templateId: w.templateId,
          count: w._count,
          successCount,
          failureCount,
          successRate: total > 0 ? (successCount / total) * 100 : 0,
          avgDurationMs: w._avg?.durationMs ?? 0,
        };
      }),
    );

    return results.sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /**
   * Get top agents by task completion
   */
  async getTopAgents(
    tenantId: string,
    timeRange: TimeRange,
    limit: number = 10,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<
    Array<{
      agentId: string;
      agentName: string;
      tasksCompleted: number;
      tasksFailed: number;
      avgDurationMs: number;
    }>
  > {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );

    const agents = await this.prisma.workflowStepMetric.groupBy({
      by: ['agentId', 'agentName'],
      where: {
        tenantId,
        timestamp: { gte: start, lte: end },
        agentId: { not: null },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      _count: true,
      _avg: { durationMs: true },
    });

    const results = await Promise.all(
      agents.slice(0, limit * 2).map(async (a) => {
        const statusCounts = await this.prisma.workflowStepMetric.groupBy({
          by: ['status'],
          where: {
            tenantId,
            agentId: a.agentId,
            timestamp: { gte: start, lte: end },
            status: { in: ['COMPLETED', 'FAILED'] },
          },
          _count: true,
        });

        const completed =
          statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
        const failed =
          statusCounts.find((s) => s.status === 'FAILED')?._count ?? 0;

        return {
          agentId: a.agentId!,
          agentName: a.agentName ?? 'Unknown',
          tasksCompleted: completed,
          tasksFailed: failed,
          avgDurationMs: a._avg?.durationMs ?? 0,
        };
      }),
    );

    return results.sort((a, b) => b.tasksCompleted - a.tasksCompleted).slice(0, limit);
  }

  /**
   * Get recent errors
   */
  async getRecentErrors(
    tenantId: string,
    limit: number = 10,
  ): Promise<
    Array<{
      workflowRunId: string;
      workflowName: string;
      errorType: string | null;
      errorMessage: string | null;
      timestamp: Date;
    }>
  > {
    const errors = await this.prisma.workflowExecutionMetric.findMany({
      where: {
        tenantId,
        status: 'FAILED',
        errorMessage: { not: null },
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: {
        workflowRunId: true,
        workflowName: true,
        errorType: true,
        errorMessage: true,
        timestamp: true,
      },
    });

    return errors;
  }

  /**
   * Get complete dashboard summary
   */
  async getDashboardSummary(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<DashboardSummary> {
    const [
      kpis,
      executionsTrend,
      successRateTrend,
      durationTrend,
      topWorkflows,
      topAgents,
      recentErrors,
    ] = await Promise.all([
      this.getKPISummary(tenantId, timeRange, customStart, customEnd),
      this.getExecutionTrends(
        tenantId,
        timeRange,
        this.getOptimalPeriod(timeRange),
        customStart,
        customEnd,
      ),
      this.getTimeSeries(
        tenantId,
        'workflow_success_rate',
        timeRange,
        this.getOptimalPeriod(timeRange),
        customStart,
        customEnd,
      ),
      this.getTimeSeries(
        tenantId,
        'workflow_execution_duration',
        timeRange,
        this.getOptimalPeriod(timeRange),
        customStart,
        customEnd,
      ),
      this.getTopWorkflows(tenantId, timeRange, 5, customStart, customEnd),
      this.getTopAgents(tenantId, timeRange, 5, customStart, customEnd),
      this.getRecentErrors(tenantId, 5),
    ]);

    return {
      kpis,
      trends: {
        executionsTrend,
        successRateTrend,
        durationTrend,
      },
      topWorkflows,
      topAgents,
      recentErrors,
    };
  }

  /**
   * Get period-over-period comparison
   */
  async getComparison(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<{
    current: KPISummary;
    previous: KPISummary;
    changes: {
      executionsChange: number;
      successRateChange: number;
      durationChange: number;
    };
  }> {
    const { start, end } = this.getTimeRangeDates(
      timeRange,
      customStart,
      customEnd,
    );
    const periodMs = end.getTime() - start.getTime();

    const previousStart = new Date(start.getTime() - periodMs);
    const previousEnd = new Date(start.getTime());

    const [current, previous] = await Promise.all([
      this.getKPISummary(tenantId, TimeRange.CUSTOM, start, end),
      this.getKPISummary(tenantId, TimeRange.CUSTOM, previousStart, previousEnd),
    ]);

    return {
      current,
      previous,
      changes: {
        executionsChange:
          previous.totalExecutions > 0
            ? ((current.totalExecutions - previous.totalExecutions) /
                previous.totalExecutions) *
              100
            : 0,
        successRateChange: current.successRate - previous.successRate,
        durationChange:
          previous.avgDurationMs > 0
            ? ((current.avgDurationMs - previous.avgDurationMs) /
                previous.avgDurationMs) *
              100
            : 0,
      },
    };
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  private getTimeRangeDates(
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): { start: Date; end: Date } {
    const end = customEnd ?? new Date();
    let start: Date;

    switch (timeRange) {
      case TimeRange.LAST_HOUR:
        start = new Date(end.getTime() - 60 * 60 * 1000);
        break;
      case TimeRange.LAST_6_HOURS:
        start = new Date(end.getTime() - 6 * 60 * 60 * 1000);
        break;
      case TimeRange.LAST_24_HOURS:
        start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
        break;
      case TimeRange.LAST_7_DAYS:
        start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case TimeRange.LAST_30_DAYS:
        start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case TimeRange.CUSTOM:
        start = customStart ?? new Date(end.getTime() - 24 * 60 * 60 * 1000);
        break;
      default:
        start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    }

    return { start, end };
  }

  private getOptimalPeriod(timeRange: TimeRange): AggregationPeriod {
    switch (timeRange) {
      case TimeRange.LAST_HOUR:
        return '1m';
      case TimeRange.LAST_6_HOURS:
        return '5m';
      case TimeRange.LAST_24_HOURS:
        return '15m';
      case TimeRange.LAST_7_DAYS:
        return '1h';
      case TimeRange.LAST_30_DAYS:
        return '1d';
      default:
        return '1h';
    }
  }

  // =========================================================================
  // Phase 7: Goal Run Analytics
  // =========================================================================

  /**
   * Get goal run KPI summary
   */
  async getGoalRunKPIs(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<{
    totalGoalRuns: number;
    completedGoalRuns: number;
    failedGoalRuns: number;
    cancelledGoalRuns: number;
    successRate: number;
    avgDurationMs: number;
    avgStepsPerGoal: number;
    avgReplanCount: number;
    templateUsageRate: number;
  }> {
    const { start, end } = this.getTimeRangeDates(timeRange, customStart, customEnd);

    // Get goal run counts by status
    const statusCounts = await this.prisma.goalRun.groupBy({
      by: ['status'],
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      _count: true,
    });

    const completed = statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
    const failed = statusCounts.find((s) => s.status === 'FAILED')?._count ?? 0;
    const cancelled = statusCounts.find((s) => s.status === 'CANCELLED')?._count ?? 0;
    const total = statusCounts.reduce((acc, s) => acc + s._count, 0);

    // Get duration metrics for completed goal runs
    const completedRuns = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
        createdAt: { gte: start, lte: end },
        completedAt: { not: null },
        startedAt: { not: null },
      },
      select: {
        startedAt: true,
        completedAt: true,
        currentPlanVersion: true,
      },
    });

    let avgDurationMs = 0;
    let avgReplanCount = 0;

    if (completedRuns.length > 0) {
      const durations = completedRuns.map(
        (r) => r.completedAt!.getTime() - r.startedAt!.getTime(),
      );
      avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
      avgReplanCount =
        completedRuns.reduce((a, r) => a + (r.currentPlanVersion - 1), 0) /
        completedRuns.length;
    }

    // Get average steps per goal
    const stepStats = await this.prisma.checklistItem.groupBy({
      by: ['planVersionId'],
      _count: true,
    });

    const avgStepsPerGoal =
      stepStats.length > 0
        ? stepStats.reduce((a, s) => a + s._count, 0) / stepStats.length
        : 0;

    // Get template usage rate
    const templateUsageCount = await this.prisma.goalRunFromTemplate.count({
      where: {
        createdAt: { gte: start, lte: end },
      },
    });

    return {
      totalGoalRuns: total,
      completedGoalRuns: completed,
      failedGoalRuns: failed,
      cancelledGoalRuns: cancelled,
      successRate: total > 0 ? (completed / total) * 100 : 0,
      avgDurationMs,
      avgStepsPerGoal,
      avgReplanCount,
      templateUsageRate: total > 0 ? (templateUsageCount / total) * 100 : 0,
    };
  }

  /**
   * Get goal run trends over time
   */
  async getGoalRunTrends(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<TimeSeriesPoint[]> {
    const { start, end } = this.getTimeRangeDates(timeRange, customStart, customEnd);
    const period = this.getOptimalPeriod(timeRange);

    // Get goal runs grouped by time bucket
    const goalRuns = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      select: {
        createdAt: true,
        status: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by time bucket
    const buckets = new Map<string, { total: number; completed: number; failed: number }>();
    const periodMs = this.getPeriodMs(period);

    for (const run of goalRuns) {
      const bucketTime = new Date(
        Math.floor(run.createdAt.getTime() / periodMs) * periodMs,
      ).toISOString();

      if (!buckets.has(bucketTime)) {
        buckets.set(bucketTime, { total: 0, completed: 0, failed: 0 });
      }

      const bucket = buckets.get(bucketTime)!;
      bucket.total++;
      if (run.status === 'COMPLETED') bucket.completed++;
      if (run.status === 'FAILED') bucket.failed++;
    }

    return Array.from(buckets.entries()).map(([timestamp, data]) => ({
      timestamp: new Date(timestamp),
      value: data.total,
      metadata: {
        completed: data.completed,
        failed: data.failed,
        successRate: data.total > 0 ? (data.completed / data.total) * 100 : 0,
      },
    }));
  }

  /**
   * Get top templates by usage
   */
  async getTopTemplates(
    tenantId: string,
    timeRange: TimeRange,
    limit: number = 10,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<
    Array<{
      templateId: string;
      templateName: string;
      usageCount: number;
      successRate: number;
      avgDurationMs: number;
    }>
  > {
    const { start, end } = this.getTimeRangeDates(timeRange, customStart, customEnd);

    // Get template usage from junction table
    const templateUsage = await this.prisma.goalRunFromTemplate.groupBy({
      by: ['templateId'],
      where: {
        createdAt: { gte: start, lte: end },
      },
      _count: true,
    });

    // Get template details and success rates
    const results = await Promise.all(
      templateUsage.slice(0, limit * 2).map(async (t) => {
        const template = await this.prisma.goalTemplate.findUnique({
          where: { id: t.templateId },
          select: { name: true },
        });

        // Get goal run IDs from this template
        const goalRunIds = await this.prisma.goalRunFromTemplate.findMany({
          where: {
            templateId: t.templateId,
            createdAt: { gte: start, lte: end },
          },
          select: { goalRunId: true },
        });

        // Get success rate
        const statusCounts = await this.prisma.goalRun.groupBy({
          by: ['status'],
          where: {
            id: { in: goalRunIds.map((g) => g.goalRunId) },
          },
          _count: true,
        });

        const completed = statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
        const total = statusCounts.reduce((a, s) => a + s._count, 0);

        // Calculate average duration from completed goal runs
        const completedRuns = await this.prisma.goalRun.findMany({
          where: {
            id: { in: goalRunIds.map((g) => g.goalRunId) },
            status: 'COMPLETED',
            startedAt: { not: null },
            completedAt: { not: null },
          },
          select: { startedAt: true, completedAt: true },
        });

        let avgDurationMs = 0;
        if (completedRuns.length > 0) {
          const totalMs = completedRuns.reduce((sum, run) => {
            if (run.startedAt && run.completedAt) {
              return sum + (run.completedAt.getTime() - run.startedAt.getTime());
            }
            return sum;
          }, 0);
          avgDurationMs = Math.round(totalMs / completedRuns.length);
        }

        return {
          templateId: t.templateId,
          templateName: template?.name ?? 'Unknown',
          usageCount: t._count,
          successRate: total > 0 ? (completed / total) * 100 : 0,
          avgDurationMs,
        };
      }),
    );

    return results.sort((a, b) => b.usageCount - a.usageCount).slice(0, limit);
  }

  /**
   * Get batch execution statistics
   */
  async getBatchStats(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<{
    totalBatches: number;
    completedBatches: number;
    partiallyCompletedBatches: number;
    failedBatches: number;
    totalGoalsInBatches: number;
    avgGoalsPerBatch: number;
    avgBatchDurationMs: number;
  }> {
    const { start, end } = this.getTimeRangeDates(timeRange, customStart, customEnd);

    const statusCounts = await this.prisma.goalRunBatch.groupBy({
      by: ['status'],
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      _count: true,
    });

    const completed = statusCounts.find((s) => s.status === 'COMPLETED')?._count ?? 0;
    const partial =
      statusCounts.find((s) => s.status === 'PARTIALLY_COMPLETED')?._count ?? 0;
    const failed = statusCounts.find((s) => s.status === 'FAILED')?._count ?? 0;
    const total = statusCounts.reduce((a, s) => a + s._count, 0);

    // Get batch size stats
    const batchStats = await this.prisma.goalRunBatch.aggregate({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
      },
      _avg: { totalGoals: true },
      _sum: { totalGoals: true },
    });

    // Calculate average batch duration from completed batches
    const completedBatches = await this.prisma.goalRunBatch.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lte: end },
        status: { in: ['COMPLETED', 'PARTIALLY_COMPLETED'] },
        startedAt: { not: null },
        completedAt: { not: null },
      },
      select: { startedAt: true, completedAt: true },
    });

    let avgBatchDurationMs = 0;
    if (completedBatches.length > 0) {
      const totalMs = completedBatches.reduce((sum, batch) => {
        if (batch.startedAt && batch.completedAt) {
          return sum + (batch.completedAt.getTime() - batch.startedAt.getTime());
        }
        return sum;
      }, 0);
      avgBatchDurationMs = Math.round(totalMs / completedBatches.length);
    }

    return {
      totalBatches: total,
      completedBatches: completed,
      partiallyCompletedBatches: partial,
      failedBatches: failed,
      totalGoalsInBatches: batchStats._sum?.totalGoals ?? 0,
      avgGoalsPerBatch: batchStats._avg?.totalGoals ?? 0,
      avgBatchDurationMs,
    };
  }

  /**
   * Get goal run phase distribution
   */
  async getPhaseDistribution(
    tenantId: string,
  ): Promise<Array<{ phase: string; count: number; percentage: number }>> {
    const phaseCounts = await this.prisma.goalRun.groupBy({
      by: ['phase'],
      where: {
        tenantId,
        status: 'RUNNING',
      },
      _count: true,
    });

    const total = phaseCounts.reduce((a, p) => a + p._count, 0);

    return phaseCounts.map((p) => ({
      phase: p.phase,
      count: p._count,
      percentage: total > 0 ? (p._count / total) * 100 : 0,
    }));
  }

  /**
   * Get execution insights dashboard
   */
  async getExecutionInsights(
    tenantId: string,
    timeRange: TimeRange,
    customStart?: Date,
    customEnd?: Date,
  ): Promise<{
    goalRunKPIs: Awaited<ReturnType<typeof this.getGoalRunKPIs>>;
    goalRunTrends: TimeSeriesPoint[];
    topTemplates: Awaited<ReturnType<typeof this.getTopTemplates>>;
    batchStats: Awaited<ReturnType<typeof this.getBatchStats>>;
    phaseDistribution: Awaited<ReturnType<typeof this.getPhaseDistribution>>;
    recentFailures: Array<{
      goalRunId: string;
      goal: string;
      error: string | null;
      failedAt: Date;
    }>;
  }> {
    const [
      goalRunKPIs,
      goalRunTrends,
      topTemplates,
      batchStats,
      phaseDistribution,
      recentFailures,
    ] = await Promise.all([
      this.getGoalRunKPIs(tenantId, timeRange, customStart, customEnd),
      this.getGoalRunTrends(tenantId, timeRange, customStart, customEnd),
      this.getTopTemplates(tenantId, timeRange, 5, customStart, customEnd),
      this.getBatchStats(tenantId, timeRange, customStart, customEnd),
      this.getPhaseDistribution(tenantId),
      this.prisma.goalRun.findMany({
        where: {
          tenantId,
          status: 'FAILED',
        },
        orderBy: { completedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          goal: true,
          error: true,
          completedAt: true,
        },
      }).then((runs) =>
        runs.map((r) => ({
          goalRunId: r.id,
          goal: r.goal.substring(0, 100),
          error: r.error,
          failedAt: r.completedAt ?? new Date(),
        })),
      ),
    ]);

    return {
      goalRunKPIs,
      goalRunTrends,
      topTemplates,
      batchStats,
      phaseDistribution,
      recentFailures,
    };
  }

  private getPeriodMs(period: AggregationPeriod): number {
    switch (period) {
      case '1m':
        return 60 * 1000;
      case '5m':
        return 5 * 60 * 1000;
      case '15m':
        return 15 * 60 * 1000;
      case '1h':
        return 60 * 60 * 1000;
      case '1d':
        return 24 * 60 * 60 * 1000;
      default:
        return 60 * 60 * 1000;
    }
  }
}
