/**
 * Dashboard Service
 * v1.0.0: Real-Time Dashboard Visualization for Agent Monitoring
 *
 * Implements industry-standard patterns for agent observability:
 * - OpenAI: Run status and streaming progress
 * - Grafana: Time-series metrics with aggregation
 * - Datadog: Real-time event streams with filtering
 *
 * Key Features:
 * 1. Aggregated metrics for all active goal runs
 * 2. Timeline visualization data for multi-step workflows
 * 3. Health status across all agents
 * 4. Real-time event streaming via WebSocket/SSE
 * 5. Historical analytics with time-range queries
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS_V2.md
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { GoalCheckpointService } from './goal-checkpoint.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { KnowledgeExtractionService } from './knowledge-extraction.service';
import { BackgroundModeService } from './background-mode.service';

// Dashboard Overview Response
export interface DashboardOverview {
  timestamp: Date;
  summary: {
    activeGoals: number;
    completedToday: number;
    failedToday: number;
    averageCompletionTime: number; // ms
    successRate: number; // percentage
  };
  recentActivity: ActivityItem[];
  agentHealth: AgentHealthSummary;
  resourceUtilization: ResourceMetrics;
}

// Activity Stream Item
export interface ActivityItem {
  id: string;
  timestamp: Date;
  type: 'goal_started' | 'step_completed' | 'step_failed' | 'goal_completed' | 'goal_failed' | 'replan' | 'alert';
  goalRunId: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'success';
  metadata?: Record<string, any>;
}

// Agent Health Summary
export interface AgentHealthSummary {
  totalAgents: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  agents: Array<{
    id: string;
    name: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    successRate: number;
    avgResponseTime: number;
    activeGoals: number;
  }>;
}

// Resource Metrics
export interface ResourceMetrics {
  backgroundTasks: {
    queued: number;
    running: number;
    completed: number;
  };
  checkpoints: {
    active: number;
    totalSize: number;
  };
  knowledgeGraphs: {
    totalFacts: number;
    totalEntities: number;
  };
}

// Goal Timeline for Visualization
export interface GoalTimeline {
  goalRunId: string;
  goalDescription: string;
  status: string;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
  steps: Array<{
    order: number;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
    startedAt?: Date;
    completedAt?: Date;
    duration?: number;
    outcome?: string;
  }>;
  metrics: {
    stepsCompleted: number;
    stepsFailed: number;
    stepsRemaining: number;
    progressPercent: number;
    estimatedTimeRemaining?: number;
  };
}

// Historical Analytics
export interface HistoricalAnalytics {
  timeRange: {
    start: Date;
    end: Date;
  };
  totals: {
    goalsStarted: number;
    goalsCompleted: number;
    goalsFailed: number;
    stepsExecuted: number;
  };
  timeSeries: Array<{
    timestamp: Date;
    goalsStarted: number;
    goalsCompleted: number;
    goalsFailed: number;
    avgCompletionTime: number;
  }>;
  topFailureReasons: Array<{
    reason: string;
    count: number;
    percentage: number;
  }>;
  performanceByHour: Array<{
    hour: number;
    successRate: number;
    avgDuration: number;
  }>;
}

@Injectable()
export class DashboardService implements OnModuleInit {
  private readonly logger = new Logger(DashboardService.name);
  private readonly enabled: boolean;

  // Activity stream buffer (in-memory, latest 1000 items)
  private activityStream: ActivityItem[] = [];
  private readonly maxActivityItems = 1000;

  // Cached metrics (updated periodically)
  private cachedOverview: DashboardOverview | null = null;
  private cacheExpiry: Date = new Date(0);
  private readonly cacheTtlMs = 10000; // 10 seconds

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly checkpointService: GoalCheckpointService,
    private readonly circuitBreakerService: CircuitBreakerService,
    private readonly knowledgeService: KnowledgeExtractionService,
    private readonly backgroundService: BackgroundModeService,
  ) {
    this.enabled = this.configService.get('DASHBOARD_ENABLED', 'true') === 'true';
    this.logger.log(`Dashboard service ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Pre-populate activity stream with recent events
    await this.loadRecentActivity();
    this.logger.log('Dashboard service initialized');
  }

  /**
   * Get dashboard overview with aggregated metrics
   */
  async getOverview(): Promise<DashboardOverview> {
    // Return cached if valid
    if (this.cachedOverview && this.cacheExpiry > new Date()) {
      return this.cachedOverview;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Get goal run statistics
    const [activeGoals, completedToday, failedToday, allRecentGoals] = await Promise.all([
      this.prisma.goalRun.count({
        where: { status: 'RUNNING' },
      }),
      this.prisma.goalRun.count({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: todayStart },
        },
      }),
      this.prisma.goalRun.count({
        where: {
          status: 'FAILED',
          completedAt: { gte: todayStart },
        },
      }),
      this.prisma.goalRun.findMany({
        where: {
          completedAt: { gte: todayStart },
          status: { in: ['COMPLETED', 'FAILED'] },
        },
        select: {
          status: true,
          startedAt: true,
          completedAt: true,
        },
      }),
    ]);

    // Calculate average completion time
    const completionTimes = allRecentGoals
      .filter(g => g.startedAt && g.completedAt)
      .map(g => new Date(g.completedAt!).getTime() - new Date(g.startedAt!).getTime());

    const avgCompletionTime = completionTimes.length > 0
      ? completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length
      : 0;

    // Calculate success rate
    const totalToday = completedToday + failedToday;
    const successRate = totalToday > 0 ? (completedToday / totalToday) * 100 : 100;

    // Get agent health
    const agentHealth = await this.getAgentHealthSummary();

    // Get resource metrics
    const resourceUtilization = await this.getResourceMetrics();

    const overview: DashboardOverview = {
      timestamp: now,
      summary: {
        activeGoals,
        completedToday,
        failedToday,
        averageCompletionTime: Math.round(avgCompletionTime),
        successRate: Math.round(successRate * 10) / 10,
      },
      recentActivity: this.activityStream.slice(0, 20),
      agentHealth,
      resourceUtilization,
    };

    // Cache the result
    this.cachedOverview = overview;
    this.cacheExpiry = new Date(Date.now() + this.cacheTtlMs);

    return overview;
  }

  /**
   * Get detailed timeline for a specific goal
   */
  async getGoalTimeline(goalRunId: string): Promise<GoalTimeline | null> {
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
      include: {
        planVersions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: {
            checklistItems: {
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });

    if (!goalRun) {
      return null;
    }

    const plan = goalRun.planVersions[0];
    const items = plan?.checklistItems || [];

    const steps = items.map(item => ({
      order: item.order,
      description: item.description,
      status: item.status.toLowerCase() as any,
      startedAt: item.startedAt || undefined,
      completedAt: item.completedAt || undefined,
      duration: item.startedAt && item.completedAt
        ? new Date(item.completedAt).getTime() - new Date(item.startedAt).getTime()
        : undefined,
      outcome: item.actualOutcome || undefined,
    }));

    const completed = items.filter(i => i.status === 'COMPLETED').length;
    const failed = items.filter(i => i.status === 'FAILED').length;
    const remaining = items.filter(i => ['PENDING', 'IN_PROGRESS'].includes(i.status)).length;

    // Estimate remaining time based on average step duration
    const completedDurations = steps
      .filter(s => s.duration)
      .map(s => s.duration!);
    const avgStepDuration = completedDurations.length > 0
      ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length
      : 0;

    return {
      goalRunId: goalRun.id,
      goalDescription: goalRun.goal,
      status: goalRun.status,
      startedAt: goalRun.startedAt || goalRun.createdAt,
      completedAt: goalRun.completedAt || undefined,
      duration: goalRun.startedAt && goalRun.completedAt
        ? new Date(goalRun.completedAt).getTime() - new Date(goalRun.startedAt).getTime()
        : undefined,
      steps,
      metrics: {
        stepsCompleted: completed,
        stepsFailed: failed,
        stepsRemaining: remaining,
        progressPercent: items.length > 0
          ? Math.round((completed / items.length) * 100)
          : 0,
        estimatedTimeRemaining: remaining > 0 && avgStepDuration > 0
          ? Math.round(remaining * avgStepDuration)
          : undefined,
      },
    };
  }

  /**
   * Get all active goal timelines
   */
  async getActiveGoalTimelines(): Promise<GoalTimeline[]> {
    const activeGoals = await this.prisma.goalRun.findMany({
      where: { status: 'RUNNING' },
      select: { id: true },
      take: 50,
    });

    const timelines = await Promise.all(
      activeGoals.map(g => this.getGoalTimeline(g.id))
    );

    return timelines.filter((t): t is GoalTimeline => t !== null);
  }

  /**
   * Get historical analytics for a time range
   */
  async getHistoricalAnalytics(
    startDate: Date,
    endDate: Date,
    interval: 'hour' | 'day' = 'hour',
  ): Promise<HistoricalAnalytics> {
    // Get all goal runs in range
    const goalRuns = await this.prisma.goalRun.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        error: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Calculate totals
    const goalsStarted = goalRuns.length;
    const goalsCompleted = goalRuns.filter(g => g.status === 'COMPLETED').length;
    const goalsFailed = goalRuns.filter(g => g.status === 'FAILED').length;

    // Get step count
    const stepsExecuted = await this.prisma.checklistItem.count({
      where: {
        planVersion: {
          goalRun: {
            createdAt: { gte: startDate, lte: endDate },
          },
        },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
    });

    // Build time series
    const timeSeries = this.buildTimeSeries(goalRuns, startDate, endDate, interval);

    // Analyze failure reasons
    const failedGoals = goalRuns.filter(g => g.status === 'FAILED');
    const failureReasons = this.analyzeFailureReasons(failedGoals);

    // Performance by hour
    const performanceByHour = this.calculatePerformanceByHour(goalRuns);

    return {
      timeRange: { start: startDate, end: endDate },
      totals: {
        goalsStarted,
        goalsCompleted,
        goalsFailed,
        stepsExecuted,
      },
      timeSeries,
      topFailureReasons: failureReasons,
      performanceByHour,
    };
  }

  /**
   * Get activity stream with optional filtering
   */
  getActivityStream(options: {
    limit?: number;
    types?: ActivityItem['type'][];
    severity?: ActivityItem['severity'][];
    goalRunId?: string;
  } = {}): ActivityItem[] {
    let filtered = [...this.activityStream];

    if (options.types?.length) {
      filtered = filtered.filter(a => options.types!.includes(a.type));
    }

    if (options.severity?.length) {
      filtered = filtered.filter(a => options.severity!.includes(a.severity));
    }

    if (options.goalRunId) {
      filtered = filtered.filter(a => a.goalRunId === options.goalRunId);
    }

    return filtered.slice(0, options.limit || 100);
  }

  /**
   * Event handlers to populate activity stream
   */
  @OnEvent('goal.started')
  handleGoalStarted(payload: { goalRunId: string; goal: string }) {
    this.addActivity({
      type: 'goal_started',
      goalRunId: payload.goalRunId,
      message: `Goal started: ${payload.goal.substring(0, 100)}`,
      severity: 'info',
    });
  }

  @OnEvent('activity.STEP_COMPLETED')
  handleStepCompleted(payload: { goalRunId: string; checklistItemId: string; outcome?: string }) {
    this.addActivity({
      type: 'step_completed',
      goalRunId: payload.goalRunId,
      message: `Step completed${payload.outcome ? `: ${payload.outcome.substring(0, 50)}` : ''}`,
      severity: 'success',
    });
  }

  @OnEvent('activity.STEP_FAILED')
  handleStepFailed(payload: { goalRunId: string; checklistItemId: string; error?: string }) {
    this.addActivity({
      type: 'step_failed',
      goalRunId: payload.goalRunId,
      message: `Step failed${payload.error ? `: ${payload.error.substring(0, 50)}` : ''}`,
      severity: 'error',
    });
  }

  @OnEvent('goal.completed')
  handleGoalCompleted(payload: { goalRunId: string }) {
    this.addActivity({
      type: 'goal_completed',
      goalRunId: payload.goalRunId,
      message: 'Goal completed successfully',
      severity: 'success',
    });
  }

  @OnEvent('goal.failed')
  handleGoalFailed(payload: { goalRunId: string; reason?: string }) {
    this.addActivity({
      type: 'goal_failed',
      goalRunId: payload.goalRunId,
      message: `Goal failed${payload.reason ? `: ${payload.reason.substring(0, 50)}` : ''}`,
      severity: 'error',
    });
  }

  @OnEvent('plan.replanned')
  handleReplan(payload: { goalRunId: string; reason?: string }) {
    this.addActivity({
      type: 'replan',
      goalRunId: payload.goalRunId,
      message: `Plan updated${payload.reason ? `: ${payload.reason.substring(0, 50)}` : ''}`,
      severity: 'warning',
    });
  }

  @OnEvent('circuit-breaker.state-change')
  handleCircuitBreakerChange(payload: { serviceName: string; state: string }) {
    if (payload.state === 'OPEN') {
      this.addActivity({
        type: 'alert',
        goalRunId: '',
        message: `Circuit breaker OPEN for ${payload.serviceName}`,
        severity: 'error',
        metadata: { serviceName: payload.serviceName },
      });
    }
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private addActivity(activity: Omit<ActivityItem, 'id' | 'timestamp'>): void {
    const item: ActivityItem = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      timestamp: new Date(),
      ...activity,
    };

    this.activityStream.unshift(item);

    // Trim to max size
    if (this.activityStream.length > this.maxActivityItems) {
      this.activityStream = this.activityStream.slice(0, this.maxActivityItems);
    }

    // Emit for real-time streaming
    this.eventEmitter.emit('dashboard.activity', item);
  }

  private async loadRecentActivity(): Promise<void> {
    try {
      const recentGoals = await this.prisma.goalRun.findMany({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          goal: true,
          status: true,
          createdAt: true,
          completedAt: true,
        },
      });

      for (const goal of recentGoals.reverse()) {
        this.addActivity({
          type: 'goal_started',
          goalRunId: goal.id,
          message: `Goal: ${goal.goal.substring(0, 100)}`,
          severity: 'info',
        });

        if (goal.status === 'COMPLETED') {
          this.addActivity({
            type: 'goal_completed',
            goalRunId: goal.id,
            message: 'Goal completed',
            severity: 'success',
          });
        } else if (goal.status === 'FAILED') {
          this.addActivity({
            type: 'goal_failed',
            goalRunId: goal.id,
            message: 'Goal failed',
            severity: 'error',
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to load recent activity: ${(error as Error).message}`);
    }
  }

  private async getAgentHealthSummary(): Promise<AgentHealthSummary> {
    const healthOverview = this.circuitBreakerService.getAllAgentHealth();

    const agents = healthOverview.agents.map(a => {
      const total = a.successCount + a.failureCount;
      const successRate = total > 0 ? (a.successCount / total) * 100 : 100;

      let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (a.consecutiveFailures >= 5) {
        status = 'unhealthy';
      } else if (a.consecutiveFailures > 0 || successRate < 90) {
        status = 'degraded';
      }

      return {
        id: a.agentId,
        name: a.agentId,
        status,
        successRate: Math.round(successRate),
        avgResponseTime: a.responseTimeMs.length > 0
          ? Math.round(a.responseTimeMs.reduce((a, b) => a + b, 0) / a.responseTimeMs.length)
          : 0,
        activeGoals: 0, // Would need additional tracking
      };
    });

    return {
      totalAgents: agents.length || 1, // At least 1 (default agent)
      healthy: healthOverview.summary.healthy || 1,
      degraded: healthOverview.summary.degraded,
      unhealthy: healthOverview.summary.unhealthy,
      agents,
    };
  }

  private async getResourceMetrics(): Promise<ResourceMetrics> {
    const backgroundStats = this.backgroundService.getQueueStats();

    // Get checkpoint count (approximate from cache)
    const activeCheckpoints = await this.prisma.goalRun.count({
      where: {
        status: 'RUNNING',
        NOT: { constraints: { equals: {} } },
      },
    });

    return {
      backgroundTasks: {
        queued: backgroundStats.queuedTasks,
        running: backgroundStats.activeTasks,
        completed: backgroundStats.completedTasks,
      },
      checkpoints: {
        active: activeCheckpoints,
        totalSize: 0, // Would need actual calculation
      },
      knowledgeGraphs: {
        totalFacts: 0, // Would aggregate from knowledge service
        totalEntities: 0,
      },
    };
  }

  private buildTimeSeries(
    goalRuns: any[],
    startDate: Date,
    endDate: Date,
    interval: 'hour' | 'day',
  ): HistoricalAnalytics['timeSeries'] {
    const buckets = new Map<string, {
      started: number;
      completed: number;
      failed: number;
      completionTimes: number[];
    }>();

    // Initialize buckets
    const current = new Date(startDate);
    while (current <= endDate) {
      const key = interval === 'hour'
        ? current.toISOString().substring(0, 13)
        : current.toISOString().substring(0, 10);
      buckets.set(key, { started: 0, completed: 0, failed: 0, completionTimes: [] });

      if (interval === 'hour') {
        current.setHours(current.getHours() + 1);
      } else {
        current.setDate(current.getDate() + 1);
      }
    }

    // Populate buckets
    for (const goal of goalRuns) {
      const createdKey = interval === 'hour'
        ? goal.createdAt.toISOString().substring(0, 13)
        : goal.createdAt.toISOString().substring(0, 10);

      if (buckets.has(createdKey)) {
        buckets.get(createdKey)!.started++;
      }

      if (goal.completedAt) {
        const completedKey = interval === 'hour'
          ? goal.completedAt.toISOString().substring(0, 13)
          : goal.completedAt.toISOString().substring(0, 10);

        if (buckets.has(completedKey)) {
          if (goal.status === 'COMPLETED') {
            buckets.get(completedKey)!.completed++;
          } else if (goal.status === 'FAILED') {
            buckets.get(completedKey)!.failed++;
          }

          if (goal.startedAt) {
            const duration = goal.completedAt.getTime() - goal.startedAt.getTime();
            buckets.get(completedKey)!.completionTimes.push(duration);
          }
        }
      }
    }

    // Convert to array
    return Array.from(buckets.entries()).map(([key, data]) => ({
      timestamp: new Date(key),
      goalsStarted: data.started,
      goalsCompleted: data.completed,
      goalsFailed: data.failed,
      avgCompletionTime: data.completionTimes.length > 0
        ? Math.round(data.completionTimes.reduce((a, b) => a + b, 0) / data.completionTimes.length)
        : 0,
    }));
  }

  private analyzeFailureReasons(failedGoals: any[]): HistoricalAnalytics['topFailureReasons'] {
    const reasons = new Map<string, number>();

    for (const goal of failedGoals) {
      const reason = goal.outcome || 'Unknown error';
      // Normalize reason (take first 50 chars)
      const normalizedReason = reason.substring(0, 50);
      reasons.set(normalizedReason, (reasons.get(normalizedReason) || 0) + 1);
    }

    const total = failedGoals.length || 1;

    return Array.from(reasons.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private calculatePerformanceByHour(goalRuns: any[]): HistoricalAnalytics['performanceByHour'] {
    const hourlyData = new Map<number, { completed: number; failed: number; durations: number[] }>();

    // Initialize all hours
    for (let h = 0; h < 24; h++) {
      hourlyData.set(h, { completed: 0, failed: 0, durations: [] });
    }

    for (const goal of goalRuns) {
      if (!goal.completedAt) continue;

      const hour = goal.completedAt.getHours();
      const data = hourlyData.get(hour)!;

      if (goal.status === 'COMPLETED') {
        data.completed++;
      } else if (goal.status === 'FAILED') {
        data.failed++;
      }

      if (goal.startedAt) {
        data.durations.push(goal.completedAt.getTime() - goal.startedAt.getTime());
      }
    }

    return Array.from(hourlyData.entries()).map(([hour, data]) => {
      const total = data.completed + data.failed;
      return {
        hour,
        successRate: total > 0 ? Math.round((data.completed / total) * 100) : 100,
        avgDuration: data.durations.length > 0
          ? Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length)
          : 0,
      };
    });
  }
}
