/**
 * Dashboard Controller
 * v1.0.0: REST API for Real-Time Dashboard Visualization
 *
 * Provides endpoints for dashboard UI integration:
 * - Overview metrics and aggregations
 * - Goal timelines and progress
 * - Activity streams
 * - Historical analytics
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS_V2.md
 */

import {
  Controller,
  Get,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Observable, fromEvent, map } from 'rxjs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DashboardService, ActivityItem } from '../services/dashboard.service';

@ApiTags('Dashboard')
@Controller('dashboard')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get dashboard overview with aggregated metrics
   */
  @Get('overview')
  @ApiOperation({ summary: 'Get dashboard overview with all metrics' })
  @ApiResponse({ status: 200, description: 'Overview retrieved successfully' })
  async getOverview() {
    const overview = await this.dashboardService.getOverview();

    return {
      success: true,
      data: overview,
    };
  }

  /**
   * Get timeline for a specific goal
   */
  @Get('goals/:goalRunId/timeline')
  @ApiOperation({ summary: 'Get detailed timeline for a goal' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Timeline retrieved' })
  async getGoalTimeline(@Param('goalRunId') goalRunId: string) {
    const timeline = await this.dashboardService.getGoalTimeline(goalRunId);

    if (!timeline) {
      throw new HttpException('Goal not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      data: timeline,
    };
  }

  /**
   * Get all active goal timelines
   */
  @Get('goals/active')
  @ApiOperation({ summary: 'Get timelines for all active goals' })
  @ApiResponse({ status: 200, description: 'Active timelines retrieved' })
  async getActiveGoals() {
    const timelines = await this.dashboardService.getActiveGoalTimelines();

    return {
      success: true,
      data: timelines,
      count: timelines.length,
    };
  }

  /**
   * Get activity stream
   */
  @Get('activity')
  @ApiOperation({ summary: 'Get recent activity stream' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max items to return' })
  @ApiQuery({ name: 'types', required: false, description: 'Filter by activity types (comma-separated)' })
  @ApiQuery({ name: 'severity', required: false, description: 'Filter by severity (comma-separated)' })
  @ApiQuery({ name: 'goalRunId', required: false, description: 'Filter by goal run ID' })
  @ApiResponse({ status: 200, description: 'Activity stream retrieved' })
  getActivity(
    @Query('limit') limit?: string,
    @Query('types') types?: string,
    @Query('severity') severity?: string,
    @Query('goalRunId') goalRunId?: string,
  ) {
    const activities = this.dashboardService.getActivityStream({
      limit: limit ? parseInt(limit, 10) : undefined,
      types: types ? types.split(',') as any[] : undefined,
      severity: severity ? severity.split(',') as any[] : undefined,
      goalRunId,
    });

    return {
      success: true,
      data: activities,
      count: activities.length,
    };
  }

  /**
   * Server-Sent Events for real-time activity streaming
   */
  @Sse('activity/stream')
  @ApiOperation({ summary: 'Subscribe to real-time activity stream (SSE)' })
  streamActivity(): Observable<MessageEvent> {
    return fromEvent(this.eventEmitter, 'dashboard.activity').pipe(
      map((activity: ActivityItem) => ({
        data: JSON.stringify(activity),
        type: 'activity',
        id: activity.id,
      })),
    );
  }

  /**
   * Get historical analytics
   */
  @Get('analytics')
  @ApiOperation({ summary: 'Get historical analytics for a time range' })
  @ApiQuery({ name: 'start', required: true, description: 'Start date (ISO string)' })
  @ApiQuery({ name: 'end', required: false, description: 'End date (ISO string, defaults to now)' })
  @ApiQuery({ name: 'interval', required: false, description: 'Aggregation interval (hour or day)' })
  @ApiResponse({ status: 200, description: 'Analytics retrieved' })
  async getAnalytics(
    @Query('start') start: string,
    @Query('end') end?: string,
    @Query('interval') interval?: string,
  ) {
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date();

    if (isNaN(startDate.getTime())) {
      throw new HttpException('Invalid start date', HttpStatus.BAD_REQUEST);
    }

    const analytics = await this.dashboardService.getHistoricalAnalytics(
      startDate,
      endDate,
      interval as 'hour' | 'day' || 'hour',
    );

    return {
      success: true,
      data: analytics,
    };
  }

  /**
   * Get performance metrics summary
   */
  @Get('metrics')
  @ApiOperation({ summary: 'Get performance metrics summary' })
  @ApiResponse({ status: 200, description: 'Metrics retrieved' })
  async getMetrics() {
    const overview = await this.dashboardService.getOverview();

    return {
      success: true,
      data: {
        goals: overview.summary,
        agents: overview.agentHealth,
        resources: overview.resourceUtilization,
        timestamp: overview.timestamp,
      },
    };
  }

  /**
   * Get agent health details
   */
  @Get('agents/health')
  @ApiOperation({ summary: 'Get health status for all agents' })
  @ApiResponse({ status: 200, description: 'Agent health retrieved' })
  async getAgentHealth() {
    const overview = await this.dashboardService.getOverview();

    return {
      success: true,
      data: overview.agentHealth,
    };
  }

  /**
   * Get today's summary (quick stats)
   */
  @Get('today')
  @ApiOperation({ summary: 'Get quick stats for today' })
  @ApiResponse({ status: 200, description: 'Today summary retrieved' })
  async getTodaySummary() {
    const overview = await this.dashboardService.getOverview();

    return {
      success: true,
      data: {
        activeGoals: overview.summary.activeGoals,
        completedToday: overview.summary.completedToday,
        failedToday: overview.summary.failedToday,
        successRate: overview.summary.successRate,
        averageCompletionTime: overview.summary.averageCompletionTime,
        lastUpdated: overview.timestamp,
      },
    };
  }
}
