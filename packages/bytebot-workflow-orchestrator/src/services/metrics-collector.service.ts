/**
 * Metrics Collector Service
 * v1.0.0: Phase 8 Advanced Analytics Dashboard
 * v1.0.1: Fixed PrismaClientValidationError - defensive event handling
 *
 * Captures workflow and step execution metrics for analytics and dashboards.
 * Uses event-driven collection to capture metrics in real-time as workflows execute.
 *
 * Key responsibilities:
 * - Record workflow execution start/complete/fail events
 * - Record step execution metrics
 * - Integrate with Phase 7 agent metrics
 * - Provide real-time metric emission for streaming dashboards
 *
 * v1.0.1 Changes:
 * - Handle both workflowRunId and workflowId property names in events
 * - Guard against undefined IDs before Prisma queries
 * - Fetch missing data from DB when not provided in events
 * - Handle both 'success' (boolean) and 'status' (enum) formats
 * - Graceful skip when required data is unavailable
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';

// Metric types
export enum MetricType {
  WORKFLOW_EXECUTION = 'workflow_execution',
  WORKFLOW_STEP = 'workflow_step',
  AGENT_TASK = 'agent_task',
  ERROR_RATE = 'error_rate',
  THROUGHPUT = 'throughput',
}

// Workflow execution metric input
export interface WorkflowExecutionMetricInput {
  workflowRunId: string;
  tenantId: string;
  workflowName: string;
  templateId?: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  nodeCount?: number;
  completedNodeCount?: number;
  failedNodeCount?: number;
  retriedNodeCount?: number;
  agentId?: string;
  agentName?: string;
  reassignments?: number;
  errorType?: string;
  errorMessage?: string;
  peakMemoryMb?: number;
  avgCpuPercent?: number;
  tags?: Record<string, any>;
}

// Step execution metric input
export interface StepMetricInput {
  nodeId: string;
  nodeRunId: string;
  workflowRunId: string;
  tenantId: string;
  stepName: string;
  stepType: string;
  status: 'STARTED' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  queueTimeMs?: number;
  attempt?: number;
  retryCount?: number;
  toolsUsed?: string[];
  highRiskTools?: string[];
  agentId?: string;
  agentName?: string;
  memoryMb?: number;
  cpuPercent?: number;
  errorType?: string;
  errorMessage?: string;
}

// Event payloads
export interface WorkflowStartedEvent {
  workflowRunId: string;
  tenantId: string;
  workflowName: string;
  templateId?: string;
  nodeCount: number;
}

export interface WorkflowCompletedEvent {
  workflowRunId: string;
  tenantId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  completedNodeCount: number;
  failedNodeCount: number;
  retriedNodeCount: number;
  error?: { type: string; message: string };
}

export interface NodeStartedEvent {
  nodeId: string;
  nodeRunId: string;
  workflowRunId: string;
  tenantId: string;
  stepName: string;
  stepType: string;
  attempt: number;
  agentId?: string;
  agentName?: string;
}

export interface NodeCompletedEvent {
  nodeId: string;
  nodeRunId: string;
  workflowRunId: string;
  tenantId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  toolsUsed?: string[];
  highRiskTools?: string[];
  error?: { type: string; message: string };
}

@Injectable()
export class MetricsCollectorService implements OnModuleInit {
  private readonly logger = new Logger(MetricsCollectorService.name);
  private workflowStartTimes = new Map<string, Date>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit() {
    this.logger.log('Metrics Collector Service initialized');
  }

  /**
   * Record a workflow execution metric
   */
  async recordWorkflowExecution(
    input: WorkflowExecutionMetricInput,
  ): Promise<void> {
    try {
      await this.prisma.workflowExecutionMetric.create({
        data: {
          workflowRunId: input.workflowRunId,
          tenantId: input.tenantId,
          workflowName: input.workflowName,
          templateId: input.templateId,
          status: input.status,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          durationMs: input.durationMs,
          nodeCount: input.nodeCount ?? 0,
          completedNodeCount: input.completedNodeCount ?? 0,
          failedNodeCount: input.failedNodeCount ?? 0,
          retriedNodeCount: input.retriedNodeCount ?? 0,
          agentId: input.agentId,
          agentName: input.agentName,
          reassignments: input.reassignments ?? 0,
          errorType: input.errorType,
          errorMessage: input.errorMessage,
          peakMemoryMb: input.peakMemoryMb,
          avgCpuPercent: input.avgCpuPercent,
          tags: input.tags ?? {},
        },
      });

      // Emit metric event for real-time streaming
      this.eventEmitter.emit('metrics.workflow.recorded', {
        type: MetricType.WORKFLOW_EXECUTION,
        ...input,
        timestamp: new Date(),
      });

      this.logger.debug(
        `Recorded workflow execution metric: ${input.workflowRunId} (${input.status})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to record workflow execution metric: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Record a step execution metric
   */
  async recordStepExecution(input: StepMetricInput): Promise<void> {
    try {
      await this.prisma.workflowStepMetric.create({
        data: {
          nodeId: input.nodeId,
          nodeRunId: input.nodeRunId,
          workflowRunId: input.workflowRunId,
          tenantId: input.tenantId,
          stepName: input.stepName,
          stepType: input.stepType,
          status: input.status,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          durationMs: input.durationMs,
          queueTimeMs: input.queueTimeMs,
          attempt: input.attempt ?? 1,
          retryCount: input.retryCount ?? 0,
          toolsUsed: input.toolsUsed ?? [],
          highRiskTools: input.highRiskTools ?? [],
          agentId: input.agentId,
          agentName: input.agentName,
          memoryMb: input.memoryMb,
          cpuPercent: input.cpuPercent,
          errorType: input.errorType,
          errorMessage: input.errorMessage,
        },
      });

      // Emit metric event for real-time streaming
      this.eventEmitter.emit('metrics.step.recorded', {
        type: MetricType.WORKFLOW_STEP,
        ...input,
        timestamp: new Date(),
      });

      this.logger.debug(
        `Recorded step metric: ${input.nodeRunId} (${input.status})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to record step metric: ${error.message}`,
        error.stack,
      );
    }
  }

  // =========================================================================
  // Event Handlers
  // =========================================================================

  @OnEvent('workflow.started')
  async handleWorkflowStarted(event: WorkflowStartedEvent & { workflowId?: string }): Promise<void> {
    // v1.0.1: Handle both workflowRunId and workflowId property names
    const workflowRunId = event.workflowRunId || event.workflowId;

    if (!workflowRunId) {
      this.logger.warn('workflow.started event missing workflowRunId/workflowId, skipping metrics');
      return;
    }

    const startTime = new Date();
    this.workflowStartTimes.set(workflowRunId, startTime);

    // Fetch additional data from DB if not provided in event
    let tenantId = event.tenantId;
    let workflowName = event.workflowName;
    let templateId = event.templateId;
    let nodeCount = event.nodeCount;

    if (!tenantId || !workflowName) {
      try {
        const workflowRun = await this.prisma.workflowRun.findUnique({
          where: { id: workflowRunId },
          include: { nodes: true },
        });
        if (workflowRun) {
          tenantId = tenantId || workflowRun.tenantId;
          workflowName = workflowName || workflowRun.name;
          templateId = templateId || workflowRun.templateId || undefined;
          nodeCount = nodeCount ?? workflowRun.nodes?.length ?? 0;
        }
      } catch (error) {
        this.logger.debug(`Could not fetch workflow details for ${workflowRunId}: ${error.message}`);
      }
    }

    if (!tenantId) {
      this.logger.warn(`workflow.started: Missing tenantId for ${workflowRunId}, skipping metrics`);
      return;
    }

    await this.recordWorkflowExecution({
      workflowRunId,
      tenantId,
      workflowName: workflowName || 'Unknown',
      templateId,
      status: 'STARTED',
      startedAt: startTime,
      nodeCount: nodeCount ?? 0,
    });
  }

  @OnEvent('workflow.completed')
  async handleWorkflowCompleted(event: WorkflowCompletedEvent & { workflowId?: string; error?: any }): Promise<void> {
    // v1.0.1: Handle both workflowRunId and workflowId property names
    const workflowRunId = event.workflowRunId || event.workflowId;

    if (!workflowRunId) {
      this.logger.warn('workflow.completed event missing workflowRunId/workflowId, skipping metrics');
      return;
    }

    const startTime = this.workflowStartTimes.get(workflowRunId);
    const completedAt = new Date();
    const durationMs = startTime
      ? completedAt.getTime() - startTime.getTime()
      : undefined;

    // Get workflow info from DB - safely handle if workflow doesn't exist
    let workflowRun: any = null;
    try {
      workflowRun = await this.prisma.workflowRun.findUnique({
        where: { id: workflowRunId },
        include: { nodes: true },
      });
    } catch (error) {
      this.logger.debug(`Could not fetch workflow for ${workflowRunId}: ${error.message}`);
    }

    // Get tenantId from event or DB
    const tenantId = event.tenantId || workflowRun?.tenantId;
    if (!tenantId) {
      this.logger.warn(`workflow.completed: Missing tenantId for ${workflowRunId}, skipping metrics`);
      this.workflowStartTimes.delete(workflowRunId);
      return;
    }

    // Calculate node counts from DB if not provided in event
    let completedNodeCount = event.completedNodeCount;
    let failedNodeCount = event.failedNodeCount;
    let retriedNodeCount = event.retriedNodeCount;

    if (workflowRun?.nodes && (completedNodeCount === undefined || failedNodeCount === undefined)) {
      const nodes = workflowRun.nodes;
      completedNodeCount = completedNodeCount ?? nodes.filter((n: any) => n.status === 'SUCCEEDED').length;
      failedNodeCount = failedNodeCount ?? nodes.filter((n: any) => n.status === 'FAILED').length;
      retriedNodeCount = retriedNodeCount ?? nodes.filter((n: any) => (n.retryCount || 0) > 0).length;
    }

    // v1.0.1: Handle error as string or object
    const errorType = typeof event.error === 'object' ? event.error?.type : undefined;
    const errorMessage = typeof event.error === 'string' ? event.error : event.error?.message;

    await this.recordWorkflowExecution({
      workflowRunId,
      tenantId,
      workflowName: workflowRun?.name ?? 'Unknown',
      templateId: workflowRun?.templateId ?? undefined,
      status: event.status,
      startedAt: startTime ?? completedAt,
      completedAt,
      durationMs,
      completedNodeCount: completedNodeCount ?? 0,
      failedNodeCount: failedNodeCount ?? 0,
      retriedNodeCount: retriedNodeCount ?? 0,
      errorType,
      errorMessage,
    });

    // Cleanup
    this.workflowStartTimes.delete(workflowRunId);
  }

  @OnEvent('node.started')
  async handleNodeStarted(event: NodeStartedEvent & { workflowId?: string }): Promise<void> {
    // v1.0.1: Handle both workflowRunId and workflowId property names
    const workflowRunId = event.workflowRunId || event.workflowId;

    if (!event.nodeId) {
      this.logger.warn('node.started event missing nodeId, skipping metrics');
      return;
    }

    // Fetch tenant and node info from DB if not provided
    let tenantId = event.tenantId;
    let stepName = event.stepName;
    let stepType = event.stepType;
    let nodeRunId = event.nodeRunId;

    if (!tenantId || !stepName) {
      try {
        // Try to get info from the node
        const node = await this.prisma.workflowNode.findUnique({
          where: { id: event.nodeId },
          include: { workflowRun: true },
        });
        if (node) {
          tenantId = tenantId || node.workflowRun?.tenantId;
          stepName = stepName || node.name;
          stepType = stepType || node.type;
        }
      } catch (error) {
        this.logger.debug(`Could not fetch node details for ${event.nodeId}: ${error.message}`);
      }
    }

    if (!tenantId) {
      this.logger.debug(`node.started: Missing tenantId for node ${event.nodeId}, skipping metrics`);
      return;
    }

    await this.recordStepExecution({
      nodeId: event.nodeId,
      nodeRunId: nodeRunId || event.nodeId, // Use nodeId as fallback
      workflowRunId: workflowRunId || '',
      tenantId,
      stepName: stepName || 'Unknown',
      stepType: stepType || 'TASK',
      status: 'STARTED',
      startedAt: new Date(),
      attempt: event.attempt ?? 1,
      agentId: event.agentId,
      agentName: event.agentName,
    });
  }

  @OnEvent('node.completed')
  async handleNodeCompleted(event: NodeCompletedEvent & { workflowId?: string; success?: boolean }): Promise<void> {
    // v1.0.1: Handle both workflowRunId and workflowId property names
    const workflowRunId = event.workflowRunId || event.workflowId;

    if (!event.nodeId) {
      this.logger.warn('node.completed event missing nodeId, skipping metrics');
      return;
    }

    // v1.0.1: Handle both 'status' (enum) and 'success' (boolean) formats
    const statusMap: Record<string, 'COMPLETED' | 'FAILED' | 'SKIPPED'> = {
      SUCCEEDED: 'COMPLETED',
      FAILED: 'FAILED',
      SKIPPED: 'SKIPPED',
    };

    let status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
    if (event.status) {
      status = statusMap[event.status] ?? 'COMPLETED';
    } else if (event.success !== undefined) {
      status = event.success ? 'COMPLETED' : 'FAILED';
    } else {
      status = 'COMPLETED';
    }

    // Get node info from DB - handle undefined nodeRunId safely
    let nodeRun: any = null;
    let tenantId = event.tenantId;
    let stepName: string | undefined;
    let stepType: string | undefined;

    // Try to fetch from nodeRunId first, then fall back to nodeId
    if (event.nodeRunId) {
      try {
        nodeRun = await this.prisma.workflowNodeRun.findUnique({
          where: { id: event.nodeRunId },
          include: { node: true },
        });
      } catch (error) {
        this.logger.debug(`Could not fetch nodeRun ${event.nodeRunId}: ${error.message}`);
      }
    }

    // Fall back to fetching node directly
    if (!nodeRun && event.nodeId) {
      try {
        const node = await this.prisma.workflowNode.findUnique({
          where: { id: event.nodeId },
          include: { workflowRun: true },
        });
        if (node) {
          tenantId = tenantId || node.workflowRun?.tenantId;
          stepName = node.name;
          stepType = node.type;
        }
      } catch (error) {
        this.logger.debug(`Could not fetch node ${event.nodeId}: ${error.message}`);
      }
    } else if (nodeRun) {
      stepName = nodeRun.node?.name;
      stepType = nodeRun.node?.type;
    }

    if (!tenantId) {
      this.logger.debug(`node.completed: Missing tenantId for node ${event.nodeId}, skipping metrics`);
      return;
    }

    const completedAt = new Date();
    const startedAt = nodeRun?.startedAt ?? completedAt;

    await this.recordStepExecution({
      nodeId: event.nodeId,
      nodeRunId: event.nodeRunId || event.nodeId, // Use nodeId as fallback
      workflowRunId: workflowRunId || '',
      tenantId,
      stepName: stepName ?? 'Unknown',
      stepType: stepType ?? 'TASK',
      status,
      startedAt,
      completedAt,
      durationMs: event.durationMs,
      toolsUsed: event.toolsUsed,
      highRiskTools: event.highRiskTools,
      errorType: event.error?.type,
      errorMessage: event.error?.message,
    });
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  /**
   * Get real-time metrics summary for the last N minutes
   */
  async getRealtimeSummary(
    tenantId: string,
    minutesBack: number = 5,
  ): Promise<{
    workflowsStarted: number;
    workflowsCompleted: number;
    workflowsFailed: number;
    avgDurationMs: number;
    stepsCompleted: number;
    stepsFailed: number;
  }> {
    const since = new Date(Date.now() - minutesBack * 60 * 1000);

    const [workflowMetrics, stepMetrics] = await Promise.all([
      this.prisma.workflowExecutionMetric.groupBy({
        by: ['status'],
        where: {
          tenantId,
          timestamp: { gte: since },
        },
        _count: true,
        _avg: { durationMs: true },
      }),
      this.prisma.workflowStepMetric.groupBy({
        by: ['status'],
        where: {
          tenantId,
          timestamp: { gte: since },
        },
        _count: true,
      }),
    ]);

    const workflowsByStatus = Object.fromEntries(
      workflowMetrics.map((m) => [m.status, m._count]),
    );

    const stepsByStatus = Object.fromEntries(
      stepMetrics.map((m) => [m.status, m._count]),
    );

    const avgDuration =
      workflowMetrics.find((m) => m.status === 'COMPLETED')?._avg?.durationMs ??
      0;

    return {
      workflowsStarted: workflowsByStatus['STARTED'] ?? 0,
      workflowsCompleted: workflowsByStatus['COMPLETED'] ?? 0,
      workflowsFailed: workflowsByStatus['FAILED'] ?? 0,
      avgDurationMs: avgDuration,
      stepsCompleted: stepsByStatus['COMPLETED'] ?? 0,
      stepsFailed: stepsByStatus['FAILED'] ?? 0,
    };
  }

  /**
   * Get workflow execution history for a tenant
   */
  async getWorkflowHistory(
    tenantId: string,
    options: {
      limit?: number;
      offset?: number;
      status?: string;
      workflowName?: string;
      since?: Date;
      until?: Date;
    } = {},
  ): Promise<{
    executions: any[];
    total: number;
  }> {
    const { limit = 50, offset = 0, status, workflowName, since, until } = options;

    const where: any = { tenantId };

    if (status) {
      where.status = status;
    }
    if (workflowName) {
      where.workflowName = { contains: workflowName, mode: 'insensitive' };
    }
    if (since) {
      where.timestamp = { ...where.timestamp, gte: since };
    }
    if (until) {
      where.timestamp = { ...where.timestamp, lte: until };
    }

    const [executions, total] = await Promise.all([
      this.prisma.workflowExecutionMetric.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.workflowExecutionMetric.count({ where }),
    ]);

    return { executions, total };
  }
}
