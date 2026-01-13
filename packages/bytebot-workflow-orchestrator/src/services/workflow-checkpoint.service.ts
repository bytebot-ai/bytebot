/**
 * Workflow Checkpoint Service
 * v1.0.0: Phase 9 Self-Healing & Auto-Recovery
 *
 * Implements durable execution pattern (DBOS-style):
 * - Saves workflow state at key points (before/after node execution)
 * - Enables crash recovery by restoring from last checkpoint
 * - Uses optimistic locking for concurrent updates
 * - Automatic cleanup of old checkpoints
 *
 * Key concepts:
 * - Checkpoint: A snapshot of workflow/node state at a point in time
 * - Recovery: Restoring execution from the last valid checkpoint
 * - Idempotency: Ensuring operations aren't duplicated on recovery
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { LeaderElectionService } from './leader-election.service';

// Checkpoint types
export enum CheckpointType {
  WORKFLOW_STARTED = 'workflow:started',
  WORKFLOW_NODE_STARTED = 'node:started',
  WORKFLOW_NODE_COMPLETED = 'node:completed',
  WORKFLOW_NODE_FAILED = 'node:failed',
  WORKFLOW_COMPLETED = 'workflow:completed',
  WORKFLOW_FAILED = 'workflow:failed',
  CUSTOM = 'custom',
}

// Checkpoint data structure
export interface CheckpointData {
  type: CheckpointType;
  workflowRunId: string;
  tenantId: string;
  nodeId?: string;
  nodeRunId?: string;
  attempt?: number;
  state: {
    status: string;
    input?: any;
    output?: any;
    error?: string;
    metadata?: Record<string, any>;
  };
  timestamp: Date;
}

// Recovery options
export interface RecoveryOptions {
  skipCompletedNodes?: boolean;
  resetFailedNodes?: boolean;
  fromCheckpoint?: string;
}

// Recovery result
export interface RecoveryResult {
  workflowRunId: string;
  success: boolean;
  checkpointUsed: string | null;
  nodesRecovered: number;
  nodesSkipped: number;
  error?: string;
}

@Injectable()
export class WorkflowCheckpointService implements OnModuleInit {
  private readonly logger = new Logger(WorkflowCheckpointService.name);

  // Configuration
  private readonly checkpointRetentionDays: number;
  private readonly checkpointEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly leaderElection: LeaderElectionService,
  ) {
    this.checkpointRetentionDays = this.configService.get<number>(
      'CHECKPOINT_RETENTION_DAYS',
      7,
    );
    this.checkpointEnabled = this.configService.get<boolean>(
      'CHECKPOINT_ENABLED',
      true,
    );
  }

  onModuleInit() {
    this.logger.log(
      `Workflow Checkpoint Service initialized (enabled: ${this.checkpointEnabled}, ` +
      `retention: ${this.checkpointRetentionDays} days)`,
    );
  }

  /**
   * Create a checkpoint for a workflow or node
   */
  async createCheckpoint(data: CheckpointData): Promise<string> {
    if (!this.checkpointEnabled) {
      return '';
    }

    const checkpointKey = this.generateCheckpointKey(data);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.checkpointRetentionDays);

    try {
      const checkpoint = await this.prisma.workflowCheckpoint.upsert({
        where: {
          workflowRunId_checkpointKey: {
            workflowRunId: data.workflowRunId,
            checkpointKey,
          },
        },
        create: {
          workflowRunId: data.workflowRunId,
          tenantId: data.tenantId,
          checkpointKey,
          state: {
            type: data.type,
            nodeId: data.nodeId,
            nodeRunId: data.nodeRunId,
            attempt: data.attempt,
            ...data.state,
            timestamp: data.timestamp.toISOString(),
          },
          metadata: {
            createdAt: new Date().toISOString(),
          },
          expiresAt,
        },
        update: {
          state: {
            type: data.type,
            nodeId: data.nodeId,
            nodeRunId: data.nodeRunId,
            attempt: data.attempt,
            ...data.state,
            timestamp: data.timestamp.toISOString(),
          },
          version: { increment: 1 },
          metadata: {
            updatedAt: new Date().toISOString(),
          },
          expiresAt,
        },
      });

      this.logger.debug(
        `Checkpoint created: ${checkpointKey} for workflow ${data.workflowRunId}`,
      );

      return checkpoint.id;
    } catch (error) {
      this.logger.error(
        `Failed to create checkpoint ${checkpointKey}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Create checkpoint before node execution
   */
  async checkpointNodeStart(
    workflowRunId: string,
    tenantId: string,
    nodeId: string,
    nodeRunId: string,
    attempt: number,
    input: any,
  ): Promise<string> {
    return this.createCheckpoint({
      type: CheckpointType.WORKFLOW_NODE_STARTED,
      workflowRunId,
      tenantId,
      nodeId,
      nodeRunId,
      attempt,
      state: {
        status: 'RUNNING',
        input,
      },
      timestamp: new Date(),
    });
  }

  /**
   * Create checkpoint after node completion
   */
  async checkpointNodeComplete(
    workflowRunId: string,
    tenantId: string,
    nodeId: string,
    nodeRunId: string,
    attempt: number,
    output: any,
  ): Promise<string> {
    return this.createCheckpoint({
      type: CheckpointType.WORKFLOW_NODE_COMPLETED,
      workflowRunId,
      tenantId,
      nodeId,
      nodeRunId,
      attempt,
      state: {
        status: 'COMPLETED',
        output,
      },
      timestamp: new Date(),
    });
  }

  /**
   * Create checkpoint after node failure
   */
  async checkpointNodeFailed(
    workflowRunId: string,
    tenantId: string,
    nodeId: string,
    nodeRunId: string,
    attempt: number,
    error: string,
  ): Promise<string> {
    return this.createCheckpoint({
      type: CheckpointType.WORKFLOW_NODE_FAILED,
      workflowRunId,
      tenantId,
      nodeId,
      nodeRunId,
      attempt,
      state: {
        status: 'FAILED',
        error,
      },
      timestamp: new Date(),
    });
  }

  /**
   * Get the latest checkpoint for a workflow
   */
  async getLatestCheckpoint(
    workflowRunId: string,
  ): Promise<{ id: string; key: string; state: any } | null> {
    const checkpoint = await this.prisma.workflowCheckpoint.findFirst({
      where: {
        workflowRunId,
        recoverable: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!checkpoint) {
      return null;
    }

    return {
      id: checkpoint.id,
      key: checkpoint.checkpointKey,
      state: checkpoint.state,
    };
  }

  /**
   * Get all checkpoints for a workflow
   */
  async getWorkflowCheckpoints(workflowRunId: string): Promise<Array<{
    id: string;
    key: string;
    version: number;
    state: any;
    createdAt: Date;
    updatedAt: Date;
  }>> {
    const checkpoints = await this.prisma.workflowCheckpoint.findMany({
      where: { workflowRunId },
      orderBy: { updatedAt: 'asc' },
    });

    return checkpoints.map((cp) => ({
      id: cp.id,
      key: cp.checkpointKey,
      version: cp.version,
      state: cp.state,
      createdAt: cp.createdAt,
      updatedAt: cp.updatedAt,
    }));
  }

  /**
   * Recover a workflow from its last checkpoint
   */
  async recoverWorkflow(
    workflowRunId: string,
    options: RecoveryOptions = {},
  ): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      workflowRunId,
      success: false,
      checkpointUsed: null,
      nodesRecovered: 0,
      nodesSkipped: 0,
    };

    try {
      // Get workflow run
      const workflowRun = await this.prisma.workflowRun.findUnique({
        where: { id: workflowRunId },
        include: {
          nodes: {
            include: {
              nodeRuns: {
                orderBy: { attempt: 'desc' },
                take: 1,
              },
            },
          },
        },
      });

      if (!workflowRun) {
        result.error = 'Workflow run not found';
        return result;
      }

      // Get checkpoints
      const checkpoints = await this.getWorkflowCheckpoints(workflowRunId);
      if (checkpoints.length === 0) {
        result.error = 'No checkpoints found for workflow';
        return result;
      }

      // Find the checkpoint to recover from
      let targetCheckpoint = checkpoints[checkpoints.length - 1];
      if (options.fromCheckpoint) {
        const found = checkpoints.find((cp) => cp.key === options.fromCheckpoint);
        if (found) {
          targetCheckpoint = found;
        }
      }

      result.checkpointUsed = targetCheckpoint.key;

      // Recover each node based on checkpoint state
      for (const node of workflowRun.nodes) {
        const nodeCheckpoints = checkpoints.filter(
          (cp) => (cp.state as any).nodeId === node.id,
        );

        const latestNodeCheckpoint = nodeCheckpoints[nodeCheckpoints.length - 1];

        if (!latestNodeCheckpoint) {
          // No checkpoint for this node - reset to PENDING
          await this.prisma.workflowNode.update({
            where: { id: node.id },
            data: { status: 'PENDING' },
          });
          result.nodesRecovered++;
          continue;
        }

        const nodeState = latestNodeCheckpoint.state as any;

        if (nodeState.status === 'COMPLETED' && options.skipCompletedNodes) {
          result.nodesSkipped++;
          continue;
        }

        if (nodeState.status === 'FAILED' && !options.resetFailedNodes) {
          result.nodesSkipped++;
          continue;
        }

        // Reset node to appropriate state for re-execution
        if (nodeState.status === 'RUNNING' || nodeState.status === 'FAILED') {
          await this.prisma.workflowNode.update({
            where: { id: node.id },
            data: {
              status: 'PENDING',
              error: null,
            },
          });

          // If there's a node run, mark it for retry
          const latestRun = node.nodeRuns[0];
          if (latestRun) {
            await this.prisma.workflowNodeRun.update({
              where: { id: latestRun.id },
              data: {
                status: 'FAILED',
                error: 'Recovered from crash - will retry',
                completedAt: new Date(),
              },
            });
          }

          result.nodesRecovered++;
        }
      }

      // Update workflow status to allow re-execution
      if (workflowRun.status === 'RUNNING' || workflowRun.status === 'FAILED') {
        await this.prisma.workflowRun.update({
          where: { id: workflowRunId },
          data: {
            status: 'PENDING',
            error: null,
          },
        });
      }

      // Log recovery action
      await this.logRecoveryAction(
        workflowRun.tenantId,
        workflowRunId,
        'WORKFLOW_RECOVERED',
        workflowRun.status,
        'PENDING',
        `Recovered from checkpoint: ${targetCheckpoint.key}`,
        true,
      );

      result.success = true;

      this.logger.log(
        `Workflow ${workflowRunId} recovered from checkpoint ${targetCheckpoint.key}: ` +
        `${result.nodesRecovered} nodes recovered, ${result.nodesSkipped} skipped`,
      );

      this.eventEmitter.emit('workflow.recovered', {
        workflowRunId,
        checkpoint: targetCheckpoint.key,
        nodesRecovered: result.nodesRecovered,
      });

      return result;
    } catch (error) {
      result.error = error.message;
      this.logger.error(
        `Failed to recover workflow ${workflowRunId}: ${error.message}`,
        error.stack,
      );
      return result;
    }
  }

  /**
   * Check if a workflow can be recovered
   */
  async canRecover(workflowRunId: string): Promise<{
    recoverable: boolean;
    checkpointCount: number;
    latestCheckpoint: string | null;
    reason?: string;
  }> {
    const workflowRun = await this.prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
    });

    if (!workflowRun) {
      return {
        recoverable: false,
        checkpointCount: 0,
        latestCheckpoint: null,
        reason: 'Workflow run not found',
      };
    }

    // Can't recover completed workflows
    if (workflowRun.status === 'COMPLETED') {
      return {
        recoverable: false,
        checkpointCount: 0,
        latestCheckpoint: null,
        reason: 'Workflow already completed',
      };
    }

    const checkpoints = await this.prisma.workflowCheckpoint.findMany({
      where: {
        workflowRunId,
        recoverable: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (checkpoints.length === 0) {
      return {
        recoverable: false,
        checkpointCount: 0,
        latestCheckpoint: null,
        reason: 'No recoverable checkpoints found',
      };
    }

    return {
      recoverable: true,
      checkpointCount: checkpoints.length,
      latestCheckpoint: checkpoints[0].checkpointKey,
    };
  }

  /**
   * Mark a checkpoint as non-recoverable (e.g., after permanent failure)
   */
  async markNonRecoverable(
    workflowRunId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.workflowCheckpoint.updateMany({
      where: { workflowRunId },
      data: {
        recoverable: false,
        recoveryHint: reason,
      },
    });

    this.logger.log(
      `Marked checkpoints for workflow ${workflowRunId} as non-recoverable: ${reason}`,
    );
  }

  /**
   * Cleanup expired checkpoints (runs daily)
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupExpiredCheckpoints(): Promise<void> {
    // Only run on leader
    if (!this.leaderElection.isLeader) {
      return;
    }

    try {
      const result = await this.prisma.workflowCheckpoint.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      if (result.count > 0) {
        this.logger.log(`Cleaned up ${result.count} expired checkpoints`);
      }
    } catch (error) {
      this.logger.error(`Checkpoint cleanup failed: ${error.message}`);
    }
  }

  /**
   * Get checkpoint statistics
   */
  async getCheckpointStats(): Promise<{
    totalCheckpoints: number;
    recoverableCheckpoints: number;
    expiringWithin24h: number;
    oldestCheckpoint: Date | null;
  }> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [total, recoverable, expiring, oldest] = await Promise.all([
      this.prisma.workflowCheckpoint.count(),
      this.prisma.workflowCheckpoint.count({
        where: { recoverable: true },
      }),
      this.prisma.workflowCheckpoint.count({
        where: {
          expiresAt: {
            lt: tomorrow,
            gte: new Date(),
          },
        },
      }),
      this.prisma.workflowCheckpoint.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    return {
      totalCheckpoints: total,
      recoverableCheckpoints: recoverable,
      expiringWithin24h: expiring,
      oldestCheckpoint: oldest?.createdAt ?? null,
    };
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Generate a unique checkpoint key
   */
  private generateCheckpointKey(data: CheckpointData): string {
    if (data.nodeId && data.nodeRunId) {
      return `${data.type}:${data.nodeId}:${data.nodeRunId}:${data.attempt ?? 1}`;
    }
    return `${data.type}:${data.workflowRunId}`;
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
          targetType: 'WORKFLOW',
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
}
