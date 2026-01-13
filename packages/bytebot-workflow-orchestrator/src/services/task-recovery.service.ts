/**
 * Task Recovery Service
 * v1.0.0: Phase 9 Self-Healing & Auto-Recovery
 *
 * Automatically detects and recovers stale/stuck tasks:
 * - Detects tasks stuck in RUNNING state beyond timeout
 * - Detects tasks assigned to offline agents
 * - Reassigns tasks to healthy agents
 * - Manages task timeout and cleanup
 *
 * Runs on a configurable schedule (default: every 30 seconds).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { AgentRouterService } from './agent-router.service';
import { LeaderElectionService } from './leader-election.service';

// Stale task reasons
export enum StaleReason {
  TIMEOUT = 'TIMEOUT',
  AGENT_OFFLINE = 'AGENT_OFFLINE',
  HEARTBEAT_MISSING = 'HEARTBEAT_MISSING',
  ASSIGNMENT_EXPIRED = 'ASSIGNMENT_EXPIRED',
}

// Recovery result
export interface RecoveryResult {
  nodeRunId: string;
  success: boolean;
  action: 'REASSIGNED' | 'MOVED_TO_DLQ' | 'SKIPPED';
  newAgentId?: string;
  error?: string;
}

// Recovery summary
export interface RecoverySummary {
  detected: number;
  recovered: number;
  movedToDLQ: number;
  failed: number;
  duration: number;
}

@Injectable()
export class TaskRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(TaskRecoveryService.name);
  private isProcessing = false;

  // Configuration
  private readonly taskTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxRecoveryAttempts: number;
  private readonly recoveryEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly agentRouter: AgentRouterService,
    private readonly leaderElection: LeaderElectionService,
  ) {
    // Default: 5 minutes for task timeout
    // v1.0.1: Use parseInt for numeric env vars (env vars are always strings)
    this.taskTimeoutMs = parseInt(
      this.configService.get<string>('TASK_TIMEOUT_MS', '300000'),
      10,
    );
    // Default: 2 minutes for heartbeat timeout
    this.heartbeatTimeoutMs = parseInt(
      this.configService.get<string>('HEARTBEAT_TIMEOUT_MS', '120000'),
      10,
    );
    // Default: 3 recovery attempts before moving to DLQ
    this.maxRecoveryAttempts = parseInt(
      this.configService.get<string>('MAX_RECOVERY_ATTEMPTS', '3'),
      10,
    );
    // Default: enabled
    // v1.0.1: Use string comparison for boolean env vars
    this.recoveryEnabled =
      this.configService.get<string>('TASK_RECOVERY_ENABLED', 'true') === 'true';
  }

  onModuleInit() {
    this.logger.log(
      `Task Recovery Service initialized (enabled: ${this.recoveryEnabled}, ` +
      `taskTimeout: ${this.taskTimeoutMs}ms, heartbeatTimeout: ${this.heartbeatTimeoutMs}ms)`,
    );
  }

  /**
   * Scheduled task recovery check (runs every 30 seconds)
   * Only runs on leader to prevent duplicate processing
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async checkStaleTasks(): Promise<void> {
    // Only run on leader
    if (!this.leaderElection.isLeader) {
      return;
    }

    if (!this.recoveryEnabled) {
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Skipping recovery check - already processing');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      const summary = await this.runRecoveryCheck();

      if (summary.detected > 0) {
        this.logger.log(
          `Recovery check completed: detected=${summary.detected}, ` +
          `recovered=${summary.recovered}, dlq=${summary.movedToDLQ}, ` +
          `failed=${summary.failed}, duration=${summary.duration}ms`,
        );

        this.eventEmitter.emit('recovery.completed', summary);
      }
    } catch (error) {
      this.logger.error(`Recovery check failed: ${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Run a full recovery check
   */
  async runRecoveryCheck(): Promise<RecoverySummary> {
    const startTime = Date.now();
    const summary: RecoverySummary = {
      detected: 0,
      recovered: 0,
      movedToDLQ: 0,
      failed: 0,
      duration: 0,
    };

    // 1. Detect stale tasks by timeout
    const timeoutTasks = await this.detectTimeoutTasks();
    summary.detected += timeoutTasks.length;

    // 2. Detect tasks assigned to offline agents
    const offlineAgentTasks = await this.detectOfflineAgentTasks();
    summary.detected += offlineAgentTasks.length;

    // 3. Recover detected tasks
    for (const task of [...timeoutTasks, ...offlineAgentTasks]) {
      const result = await this.recoverTask(task);
      if (result.success) {
        if (result.action === 'REASSIGNED') {
          summary.recovered++;
        } else if (result.action === 'MOVED_TO_DLQ') {
          summary.movedToDLQ++;
        }
      } else {
        summary.failed++;
      }
    }

    summary.duration = Date.now() - startTime;
    return summary;
  }

  /**
   * Detect tasks that have timed out
   */
  private async detectTimeoutTasks(): Promise<Array<{
    nodeRunId: string;
    workflowRunId: string;
    tenantId: string;
    assignmentId: string | null;
    agentId: string | null;
    reason: StaleReason;
    assignedAt: Date | null;
  }>> {
    const timeoutThreshold = new Date(Date.now() - this.taskTimeoutMs);

    // Find node runs that are RUNNING but haven't completed within timeout
    const staleRuns = await this.prisma.workflowNodeRun.findMany({
      where: {
        status: 'RUNNING',
        startedAt: {
          lt: timeoutThreshold,
        },
      },
      include: {
        node: {
          include: {
            workflowRun: true,
          },
        },
      },
    });

    const results: Array<{
      nodeRunId: string;
      workflowRunId: string;
      tenantId: string;
      assignmentId: string | null;
      agentId: string | null;
      reason: StaleReason;
      assignedAt: Date | null;
    }> = [];

    for (const run of staleRuns) {
      // Check if already tracked as stale
      const existingStale = await this.prisma.staleTask.findUnique({
        where: { nodeRunId: run.id },
      });

      if (!existingStale) {
        // Get current assignment
        const assignment = await this.prisma.taskAssignment.findFirst({
          where: {
            nodeRunId: run.id,
            status: { in: ['ASSIGNED', 'RUNNING'] },
          },
          orderBy: { createdAt: 'desc' },
        });

        results.push({
          nodeRunId: run.id,
          workflowRunId: run.node.workflowRunId,
          tenantId: run.node.workflowRun.tenantId,
          assignmentId: assignment?.id ?? null,
          agentId: assignment?.agentId ?? null,
          reason: StaleReason.TIMEOUT,
          assignedAt: assignment?.dispatchedAt ?? null,
        });

        // Record stale task
        await this.prisma.staleTask.create({
          data: {
            nodeRunId: run.id,
            workflowRunId: run.node.workflowRunId,
            tenantId: run.node.workflowRun.tenantId,
            staleReason: StaleReason.TIMEOUT,
            originalAgentId: assignment?.agentId,
            assignedAt: assignment?.dispatchedAt,
          },
        });
      }
    }

    return results;
  }

  /**
   * Detect tasks assigned to offline agents
   */
  private async detectOfflineAgentTasks(): Promise<Array<{
    nodeRunId: string;
    workflowRunId: string;
    tenantId: string;
    assignmentId: string | null;
    agentId: string | null;
    reason: StaleReason;
    assignedAt: Date | null;
  }>> {
    const heartbeatThreshold = new Date(Date.now() - this.heartbeatTimeoutMs);

    // Find assignments to agents that haven't sent heartbeat
    const staleAssignments = await this.prisma.taskAssignment.findMany({
      where: {
        status: { in: ['ASSIGNED', 'RUNNING'] },
        agent: {
          lastHeartbeatAt: {
            lt: heartbeatThreshold,
          },
        },
      },
      include: {
        agent: true,
      },
    });

    const results: Array<{
      nodeRunId: string;
      workflowRunId: string;
      tenantId: string;
      assignmentId: string | null;
      agentId: string | null;
      reason: StaleReason;
      assignedAt: Date | null;
    }> = [];

    for (const assignment of staleAssignments) {
      // Get the node run details
      const nodeRun = await this.prisma.workflowNodeRun.findUnique({
        where: { id: assignment.nodeRunId },
        include: {
          node: {
            include: {
              workflowRun: true,
            },
          },
        },
      });

      if (!nodeRun) continue;

      // Check if already tracked as stale
      const existingStale = await this.prisma.staleTask.findUnique({
        where: { nodeRunId: nodeRun.id },
      });

      if (!existingStale) {
        results.push({
          nodeRunId: nodeRun.id,
          workflowRunId: nodeRun.node.workflowRunId,
          tenantId: nodeRun.node.workflowRun.tenantId,
          assignmentId: assignment.id,
          agentId: assignment.agentId,
          reason: StaleReason.AGENT_OFFLINE,
          assignedAt: assignment.dispatchedAt,
        });

        // Record stale task
        await this.prisma.staleTask.create({
          data: {
            nodeRunId: nodeRun.id,
            workflowRunId: nodeRun.node.workflowRunId,
            tenantId: nodeRun.node.workflowRun.tenantId,
            staleReason: StaleReason.AGENT_OFFLINE,
            originalAgentId: assignment.agentId,
            assignedAt: assignment.dispatchedAt,
            lastHeartbeatAt: assignment.agent.lastHeartbeatAt,
          },
        });
      }
    }

    return results;
  }

  /**
   * Recover a stale task
   */
  private async recoverTask(task: {
    nodeRunId: string;
    workflowRunId: string;
    tenantId: string;
    assignmentId: string | null;
    agentId: string | null;
    reason: StaleReason;
    assignedAt: Date | null;
  }): Promise<RecoveryResult> {
    try {
      // Get stale task record
      const staleTask = await this.prisma.staleTask.findUnique({
        where: { nodeRunId: task.nodeRunId },
      });

      if (!staleTask) {
        return {
          nodeRunId: task.nodeRunId,
          success: false,
          action: 'SKIPPED',
          error: 'Stale task record not found',
        };
      }

      // Check if we've exceeded max recovery attempts
      if (staleTask.recoveryAttempts >= this.maxRecoveryAttempts) {
        return await this.moveToDeadLetterQueue(task, staleTask);
      }

      // Update recovery attempts
      await this.prisma.staleTask.update({
        where: { nodeRunId: task.nodeRunId },
        data: {
          status: 'RECOVERING',
          recoveryAttempts: staleTask.recoveryAttempts + 1,
        },
      });

      // Mark old assignment as failed
      if (task.assignmentId) {
        await this.prisma.taskAssignment.update({
          where: { id: task.assignmentId },
          data: {
            status: 'FAILED',
            error: `Task stale: ${task.reason}`,
            completedAt: new Date(),
          },
        });
      }

      // Reset node run status to allow reassignment
      await this.prisma.workflowNodeRun.update({
        where: { id: task.nodeRunId },
        data: {
          status: 'READY',
          error: `Recovered from stale state: ${task.reason}`,
        },
      });

      // Try to find a new agent (use least loaded for recovery)
      const newAgent = await this.agentRouter.routeLeastLoaded();

      if (!newAgent) {
        this.logger.warn(
          `No healthy agent available for task ${task.nodeRunId}`,
        );

        await this.prisma.staleTask.update({
          where: { nodeRunId: task.nodeRunId },
          data: {
            status: 'FAILED',
            errorMessage: 'No healthy agent available',
          },
        });

        return {
          nodeRunId: task.nodeRunId,
          success: false,
          action: 'SKIPPED',
          error: 'No healthy agent available',
        };
      }

      // Create new assignment
      await this.prisma.taskAssignment.create({
        data: {
          nodeRunId: task.nodeRunId,
          agentId: newAgent.id,
          status: 'ASSIGNED',
          routingReason: 'recovery_reassignment',
          previousAssignmentId: task.assignmentId,
          attempt: staleTask.recoveryAttempts + 1,
        },
      });

      // Update stale task as recovered
      await this.prisma.staleTask.update({
        where: { nodeRunId: task.nodeRunId },
        data: {
          status: 'RECOVERED',
          newAgentId: newAgent.id,
          recoveredAt: new Date(),
        },
      });

      // Log recovery action
      await this.logRecoveryAction(
        task.tenantId,
        task.nodeRunId,
        'TASK_REASSIGNED',
        'RUNNING',
        'READY',
        `Reassigned from ${task.agentId ?? 'unknown'} to ${newAgent.id} due to ${task.reason}`,
        true,
      );

      this.logger.log(
        `Task ${task.nodeRunId} recovered: reassigned to agent ${newAgent.id}`,
      );

      this.eventEmitter.emit('task.recovered', {
        nodeRunId: task.nodeRunId,
        oldAgentId: task.agentId,
        newAgentId: newAgent.id,
        reason: task.reason,
      });

      return {
        nodeRunId: task.nodeRunId,
        success: true,
        action: 'REASSIGNED',
        newAgentId: newAgent.id,
      };
    } catch (error) {
      this.logger.error(
        `Failed to recover task ${task.nodeRunId}: ${error.message}`,
        error.stack,
      );

      await this.prisma.staleTask.update({
        where: { nodeRunId: task.nodeRunId },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      });

      return {
        nodeRunId: task.nodeRunId,
        success: false,
        action: 'SKIPPED',
        error: error.message,
      };
    }
  }

  /**
   * Move a task to the dead letter queue
   */
  private async moveToDeadLetterQueue(
    task: {
      nodeRunId: string;
      workflowRunId: string;
      tenantId: string;
      reason: StaleReason;
    },
    staleTask: { recoveryAttempts: number },
  ): Promise<RecoveryResult> {
    try {
      // Get node run details for the DLQ entry
      const nodeRun = await this.prisma.workflowNodeRun.findUnique({
        where: { id: task.nodeRunId },
        include: {
          node: true,
        },
      });

      if (!nodeRun) {
        return {
          nodeRunId: task.nodeRunId,
          success: false,
          action: 'SKIPPED',
          error: 'Node run not found',
        };
      }

      // Create DLQ entry
      await this.prisma.deadLetterEntry.create({
        data: {
          tenantId: task.tenantId,
          workflowRunId: task.workflowRunId,
          nodeRunId: task.nodeRunId,
          taskType: 'WORKFLOW_NODE',
          originalPayload: {
            nodeId: nodeRun.nodeId,
            nodeName: nodeRun.node.name,
            nodeType: nodeRun.node.type,
            attempt: nodeRun.attempt,
            input: nodeRun.input,
          },
          failureReason: `Max recovery attempts exceeded: ${task.reason}`,
          failureCount: staleTask.recoveryAttempts,
          lastFailedAt: new Date(),
          failureCategory: 'PERMANENT',
          severity: 'high',
          maxRetries: this.maxRecoveryAttempts,
          retryCount: staleTask.recoveryAttempts,
        },
      });

      // Update node run as failed
      await this.prisma.workflowNodeRun.update({
        where: { id: task.nodeRunId },
        data: {
          status: 'FAILED',
          error: `Moved to DLQ after ${staleTask.recoveryAttempts} recovery attempts`,
          completedAt: new Date(),
        },
      });

      // Update stale task
      await this.prisma.staleTask.update({
        where: { nodeRunId: task.nodeRunId },
        data: {
          status: 'FAILED',
          errorMessage: 'Moved to dead letter queue',
        },
      });

      // Log recovery action
      await this.logRecoveryAction(
        task.tenantId,
        task.nodeRunId,
        'MOVED_TO_DLQ',
        'RECOVERING',
        'FAILED',
        `Exceeded ${this.maxRecoveryAttempts} recovery attempts`,
        true,
      );

      this.logger.warn(
        `Task ${task.nodeRunId} moved to DLQ after ${staleTask.recoveryAttempts} recovery attempts`,
      );

      this.eventEmitter.emit('task.moved-to-dlq', {
        nodeRunId: task.nodeRunId,
        workflowRunId: task.workflowRunId,
        reason: task.reason,
        attempts: staleTask.recoveryAttempts,
      });

      return {
        nodeRunId: task.nodeRunId,
        success: true,
        action: 'MOVED_TO_DLQ',
      };
    } catch (error) {
      this.logger.error(
        `Failed to move task ${task.nodeRunId} to DLQ: ${error.message}`,
        error.stack,
      );

      return {
        nodeRunId: task.nodeRunId,
        success: false,
        action: 'SKIPPED',
        error: error.message,
      };
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
    errorMessage?: string,
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
          actorType: 'SYSTEM',
          success,
          errorMessage,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log recovery action: ${error.message}`);
    }
  }

  /**
   * Get recovery statistics
   */
  async getRecoveryStats(): Promise<{
    pendingStaleTasks: number;
    recoveringTasks: number;
    recoveredLast24h: number;
    failedLast24h: number;
    dlqEntriesCount: number;
  }> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [pending, recovering, recovered, failed, dlq] = await Promise.all([
      this.prisma.staleTask.count({ where: { status: 'DETECTED' } }),
      this.prisma.staleTask.count({ where: { status: 'RECOVERING' } }),
      this.prisma.staleTask.count({
        where: {
          status: 'RECOVERED',
          recoveredAt: { gte: oneDayAgo },
        },
      }),
      this.prisma.staleTask.count({
        where: {
          status: 'FAILED',
          updatedAt: { gte: oneDayAgo },
        },
      }),
      this.prisma.deadLetterEntry.count({
        where: { status: 'PENDING' },
      }),
    ]);

    return {
      pendingStaleTasks: pending,
      recoveringTasks: recovering,
      recoveredLast24h: recovered,
      failedLast24h: failed,
      dlqEntriesCount: dlq,
    };
  }

  /**
   * Manually trigger recovery for a specific task
   */
  async manualRecover(nodeRunId: string): Promise<RecoveryResult> {
    const nodeRun = await this.prisma.workflowNodeRun.findUnique({
      where: { id: nodeRunId },
      include: {
        node: {
          include: {
            workflowRun: true,
          },
        },
      },
    });

    if (!nodeRun) {
      return {
        nodeRunId,
        success: false,
        action: 'SKIPPED',
        error: 'Node run not found',
      };
    }

    // Get or create stale task record
    let staleTask = await this.prisma.staleTask.findUnique({
      where: { nodeRunId },
    });

    if (!staleTask) {
      staleTask = await this.prisma.staleTask.create({
        data: {
          nodeRunId,
          workflowRunId: nodeRun.node.workflowRunId,
          tenantId: nodeRun.node.workflowRun.tenantId,
          staleReason: 'MANUAL_RECOVERY' as StaleReason,
          recoveryAttempts: 0,
        },
      });
    }

    // Get current assignment
    const assignment = await this.prisma.taskAssignment.findFirst({
      where: {
        nodeRunId,
        status: { in: ['ASSIGNED', 'RUNNING'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    return this.recoverTask({
      nodeRunId,
      workflowRunId: nodeRun.node.workflowRunId,
      tenantId: nodeRun.node.workflowRun.tenantId,
      assignmentId: assignment?.id ?? null,
      agentId: assignment?.agentId ?? null,
      reason: StaleReason.TIMEOUT,
      assignedAt: assignment?.dispatchedAt ?? null,
    });
  }
}
