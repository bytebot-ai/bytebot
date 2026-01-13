/**
 * Analytics Controller
 * v2.0.0: Phase 7 Enhanced Features - Execution Insights
 *
 * REST API endpoints for analytics and dashboard data.
 * Provides access to KPIs, time-series data, and comparative analysis.
 * Phase 7: Goal run analytics, template analytics, batch analytics.
 */

import {
  Controller,
  Get,
  Query,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import {
  AnalyticsQueryService,
  TimeRange,
  KPISummary,
  TimeSeriesPoint,
  DashboardSummary,
} from '../services/analytics-query.service';
import { MetricsCollectorService } from '../services/metrics-collector.service';
import { AggregationPeriod } from '../services/metrics-aggregation.service';

// Query DTOs
interface TimeRangeQuery {
  range?: string;
  start?: string;
  end?: string;
}

interface TimeSeriesQuery extends TimeRangeQuery {
  period?: string;
  metric?: string;
}

@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly analyticsQuery: AnalyticsQueryService,
    private readonly metricsCollector: MetricsCollectorService,
  ) {}

  /**
   * Get complete dashboard summary
   * GET /api/v1/analytics/dashboard/:tenantId
   */
  @Get('dashboard/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getDashboard(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ): Promise<{
    success: boolean;
    data: DashboardSummary;
    timeRange: { start: Date; end: Date; range: string };
  }> {
    const { range, start, end } = this.parseTimeRange(query);

    const data = await this.analyticsQuery.getDashboardSummary(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      data,
      timeRange: {
        start: start ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
        end: end ?? new Date(),
        range: query.range ?? '24h',
      },
    };
  }

  /**
   * Get KPI summary
   * GET /api/v1/analytics/kpis/:tenantId
   */
  @Get('kpis/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getKPIs(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ): Promise<{
    success: boolean;
    kpis: KPISummary;
  }> {
    const { range, start, end } = this.parseTimeRange(query);

    const kpis = await this.analyticsQuery.getKPISummary(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      kpis,
    };
  }

  /**
   * Get time-series data for a specific metric
   * GET /api/v1/analytics/timeseries/:tenantId
   */
  @Get('timeseries/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getTimeSeries(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeSeriesQuery,
  ): Promise<{
    success: boolean;
    metric: string;
    period: string;
    data: TimeSeriesPoint[];
  }> {
    const { range, start, end } = this.parseTimeRange(query);
    const metric = query.metric ?? 'workflow_execution_duration';
    const period = this.parsePeriod(query.period ?? '5m');

    const data = await this.analyticsQuery.getTimeSeries(
      tenantId,
      metric,
      range,
      period,
      start,
      end,
    );

    return {
      success: true,
      metric,
      period,
      data,
    };
  }

  /**
   * Get execution trends over time
   * GET /api/v1/analytics/executions/:tenantId
   */
  @Get('executions/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getExecutions(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery & { period?: string },
  ): Promise<{
    success: boolean;
    data: TimeSeriesPoint[];
  }> {
    const { range, start, end } = this.parseTimeRange(query);
    const period = this.parsePeriod(query.period ?? '1h');

    const data = await this.analyticsQuery.getExecutionTrends(
      tenantId,
      range,
      period,
      start,
      end,
    );

    return {
      success: true,
      data,
    };
  }

  /**
   * Get top workflows by execution count
   * GET /api/v1/analytics/top-workflows/:tenantId
   */
  @Get('top-workflows/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getTopWorkflows(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery & { limit?: string },
  ): Promise<{
    success: boolean;
    workflows: Array<{
      workflowName: string;
      templateId: string | null;
      count: number;
      successRate: number;
      avgDurationMs: number;
    }>;
  }> {
    const { range, start, end } = this.parseTimeRange(query);
    const limit = parseInt(query.limit ?? '10', 10);

    const workflows = await this.analyticsQuery.getTopWorkflows(
      tenantId,
      range,
      limit,
      start,
      end,
    );

    return {
      success: true,
      workflows,
    };
  }

  /**
   * Get top agents by task completion
   * GET /api/v1/analytics/top-agents/:tenantId
   */
  @Get('top-agents/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getTopAgents(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery & { limit?: string },
  ): Promise<{
    success: boolean;
    agents: Array<{
      agentId: string;
      agentName: string;
      tasksCompleted: number;
      tasksFailed: number;
      avgDurationMs: number;
    }>;
  }> {
    const { range, start, end } = this.parseTimeRange(query);
    const limit = parseInt(query.limit ?? '10', 10);

    const agents = await this.analyticsQuery.getTopAgents(
      tenantId,
      range,
      limit,
      start,
      end,
    );

    return {
      success: true,
      agents,
    };
  }

  /**
   * Get recent errors
   * GET /api/v1/analytics/errors/:tenantId
   */
  @Get('errors/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getRecentErrors(
    @Param('tenantId') tenantId: string,
    @Query('limit') limitStr?: string,
  ): Promise<{
    success: boolean;
    errors: Array<{
      workflowRunId: string;
      workflowName: string;
      errorType: string | null;
      errorMessage: string | null;
      timestamp: Date;
    }>;
  }> {
    const limit = parseInt(limitStr ?? '10', 10);

    const errors = await this.analyticsQuery.getRecentErrors(tenantId, limit);

    return {
      success: true,
      errors,
    };
  }

  /**
   * Get period-over-period comparison
   * GET /api/v1/analytics/comparison/:tenantId
   */
  @Get('comparison/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getComparison(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ): Promise<{
    success: boolean;
    current: KPISummary;
    previous: KPISummary;
    changes: {
      executionsChange: number;
      successRateChange: number;
      durationChange: number;
    };
  }> {
    const { range, start, end } = this.parseTimeRange(query);

    const comparison = await this.analyticsQuery.getComparison(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      ...comparison,
    };
  }

  /**
   * Get real-time metrics summary
   * GET /api/v1/analytics/realtime/:tenantId
   */
  @Get('realtime/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getRealtimeMetrics(
    @Param('tenantId') tenantId: string,
    @Query('minutes') minutesStr?: string,
  ): Promise<{
    success: boolean;
    data: {
      workflowsStarted: number;
      workflowsCompleted: number;
      workflowsFailed: number;
      avgDurationMs: number;
      stepsCompleted: number;
      stepsFailed: number;
    };
    timestamp: Date;
  }> {
    const minutes = parseInt(minutesStr ?? '5', 10);

    const data = await this.metricsCollector.getRealtimeSummary(
      tenantId,
      minutes,
    );

    return {
      success: true,
      data,
      timestamp: new Date(),
    };
  }

  /**
   * Get workflow execution history
   * GET /api/v1/analytics/history/:tenantId
   */
  @Get('history/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getExecutionHistory(
    @Param('tenantId') tenantId: string,
    @Query()
    query: TimeRangeQuery & {
      status?: string;
      workflowName?: string;
      limit?: string;
      offset?: string;
    },
  ): Promise<{
    success: boolean;
    executions: any[];
    total: number;
    pagination: {
      limit: number;
      offset: number;
      hasMore: boolean;
    };
  }> {
    const { start, end } = this.parseTimeRange(query);
    const limit = parseInt(query.limit ?? '50', 10);
    const offset = parseInt(query.offset ?? '0', 10);

    const result = await this.metricsCollector.getWorkflowHistory(tenantId, {
      limit,
      offset,
      status: query.status,
      workflowName: query.workflowName,
      since: start,
      until: end,
    });

    return {
      success: true,
      executions: result.executions,
      total: result.total,
      pagination: {
        limit,
        offset,
        hasMore: offset + result.executions.length < result.total,
      },
    };
  }

  /**
   * Get available metrics
   * GET /api/v1/analytics/metrics
   */
  @Get('metrics')
  @HttpCode(HttpStatus.OK)
  getAvailableMetrics(): {
    success: boolean;
    metrics: Array<{
      name: string;
      description: string;
      type: string;
      unit?: string;
    }>;
  } {
    return {
      success: true,
      metrics: [
        {
          name: 'workflow_execution_duration',
          description: 'Workflow execution duration in milliseconds',
          type: 'gauge',
          unit: 'ms',
        },
        {
          name: 'workflow_success_rate',
          description: 'Percentage of successful workflow executions',
          type: 'gauge',
          unit: '%',
        },
        {
          name: 'step_execution_duration',
          description: 'Step execution duration in milliseconds',
          type: 'gauge',
          unit: 'ms',
        },
        {
          name: 'workflow_executions_total',
          description: 'Total number of workflow executions',
          type: 'counter',
        },
        {
          name: 'step_executions_total',
          description: 'Total number of step executions',
          type: 'counter',
        },
      ],
    };
  }

  // =========================================================================
  // Phase 7: Goal Run Analytics & Execution Insights
  // =========================================================================

  /**
   * Get goal run KPIs
   * GET /api/v1/analytics/goal-runs/:tenantId
   */
  @Get('goal-runs/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getGoalRunKPIs(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ) {
    const { range, start, end } = this.parseTimeRange(query);

    const kpis = await this.analyticsQuery.getGoalRunKPIs(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      data: kpis,
    };
  }

  /**
   * Get goal run trends
   * GET /api/v1/analytics/goal-runs/:tenantId/trends
   */
  @Get('goal-runs/:tenantId/trends')
  @HttpCode(HttpStatus.OK)
  async getGoalRunTrends(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ) {
    const { range, start, end } = this.parseTimeRange(query);

    const trends = await this.analyticsQuery.getGoalRunTrends(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      data: trends,
    };
  }

  /**
   * Get top templates by usage
   * GET /api/v1/analytics/templates/:tenantId
   */
  @Get('templates/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getTopTemplates(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery & { limit?: string },
  ) {
    const { range, start, end } = this.parseTimeRange(query);
    const limit = parseInt(query.limit ?? '10', 10);

    const templates = await this.analyticsQuery.getTopTemplates(
      tenantId,
      range,
      limit,
      start,
      end,
    );

    return {
      success: true,
      data: templates,
    };
  }

  /**
   * Get batch execution statistics
   * GET /api/v1/analytics/batches/:tenantId
   */
  @Get('batches/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getBatchStats(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ) {
    const { range, start, end } = this.parseTimeRange(query);

    const stats = await this.analyticsQuery.getBatchStats(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      data: stats,
    };
  }

  /**
   * Get goal run phase distribution (active runs only)
   * GET /api/v1/analytics/phases/:tenantId
   */
  @Get('phases/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getPhaseDistribution(@Param('tenantId') tenantId: string) {
    const distribution = await this.analyticsQuery.getPhaseDistribution(tenantId);

    return {
      success: true,
      data: distribution,
    };
  }

  /**
   * Get complete execution insights dashboard
   * GET /api/v1/analytics/insights/:tenantId
   */
  @Get('insights/:tenantId')
  @HttpCode(HttpStatus.OK)
  async getExecutionInsights(
    @Param('tenantId') tenantId: string,
    @Query() query: TimeRangeQuery,
  ) {
    const { range, start, end } = this.parseTimeRange(query);

    const insights = await this.analyticsQuery.getExecutionInsights(
      tenantId,
      range,
      start,
      end,
    );

    return {
      success: true,
      data: insights,
      timeRange: {
        start: start ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
        end: end ?? new Date(),
        range: query.range ?? '24h',
      },
    };
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  private parseTimeRange(query: TimeRangeQuery): {
    range: TimeRange;
    start?: Date;
    end?: Date;
  } {
    let range: TimeRange;

    switch (query.range) {
      case '1h':
        range = TimeRange.LAST_HOUR;
        break;
      case '6h':
        range = TimeRange.LAST_6_HOURS;
        break;
      case '24h':
        range = TimeRange.LAST_24_HOURS;
        break;
      case '7d':
        range = TimeRange.LAST_7_DAYS;
        break;
      case '30d':
        range = TimeRange.LAST_30_DAYS;
        break;
      case 'custom':
        range = TimeRange.CUSTOM;
        break;
      default:
        range = TimeRange.LAST_24_HOURS;
    }

    let start: Date | undefined;
    let end: Date | undefined;

    if (query.start) {
      start = new Date(query.start);
      if (isNaN(start.getTime())) {
        throw new BadRequestException('Invalid start date');
      }
    }

    if (query.end) {
      end = new Date(query.end);
      if (isNaN(end.getTime())) {
        throw new BadRequestException('Invalid end date');
      }
    }

    return { range, start, end };
  }

  private parsePeriod(period: string): AggregationPeriod {
    switch (period) {
      case '1m':
      case '5m':
      case '15m':
      case '1h':
      case '1d':
        return period as AggregationPeriod;
      default:
        return '5m';
    }
  }
}
