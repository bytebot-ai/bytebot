/**
 * Scheduler Service
 * v1.0.5: Added poll-based dispatch mode - skips push-based NodeExecutor when enabled
 * v1.0.4: Fixed snake_case/camelCase column mapping for raw SQL queries
 *
 * This service implements the scheduling loop that:
 * 1. Finds nodes ready for execution using FOR UPDATE SKIP LOCKED
 * 2. Dispatches nodes to the NodeExecutorService (push-based, legacy)
 * 3. Handles node completion and dependency resolution
 *
 * v1.0.5: When TASK_DISPATCH_ENABLED=true, the scheduler skips push-based
 * dispatch because TaskDispatchService handles execution via events.
 *
 * Uses Kubernetes Lease-based leader election to ensure only one replica
 * runs the scheduler at a time.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { WorkflowService, NodeStatus, WorkflowStatus } from './workflow.service';
import { NodeExecutorService } from './node-executor.service';
import { WorkspaceService } from './workspace.service';
import {
  LeaderElectionService,
  LEADER_ELECTED_EVENT,
  LEADER_LOST_EVENT,
} from './leader-election.service';

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly enabled: boolean;
  private readonly batchSize: number;
  // v1.0.5: When true, skip push-based dispatch (TaskDispatchService handles via events)
  private readonly pollBasedDispatch: boolean;
  private isProcessing: boolean = false;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private workflowService: WorkflowService,
    private nodeExecutor: NodeExecutorService,
    private workspaceService: WorkspaceService,
    private eventEmitter: EventEmitter2,
    private leaderElection: LeaderElectionService,
  ) {
    this.enabled = this.configService.get<string>('SCHEDULER_ENABLED', 'true') === 'true';
    this.batchSize = parseInt(
      this.configService.get<string>('SCHEDULER_BATCH_SIZE', '10'),
      10,
    );
    // v1.0.5: Poll-based dispatch - skip push-based NodeExecutor calls
    this.pollBasedDispatch = this.configService.get<string>('TASK_DISPATCH_ENABLED', 'true') === 'true';
  }

  async onModuleInit() {
    if (this.enabled) {
      this.logger.log(`Scheduler enabled with batch size ${this.batchSize}`);
      if (this.pollBasedDispatch) {
        this.logger.log('Poll-based dispatch enabled - push-based NodeExecutor calls will be skipped');
      }
      this.logger.log('Scheduler will start processing when this instance becomes leader');
    } else {
      this.logger.warn('Scheduler is disabled');
    }
  }

  /**
   * Handle becoming the leader
   */
  @OnEvent(LEADER_ELECTED_EVENT)
  handleLeaderElected(payload: { identity: string }): void {
    this.logger.log(`Became leader with identity: ${payload.identity} - scheduler will now process`);
  }

  /**
   * Handle losing leadership
   */
  @OnEvent(LEADER_LOST_EVENT)
  handleLeaderLost(payload: { identity: string }): void {
    this.logger.warn(`Lost leadership: ${payload.identity} - scheduler paused`);
    this.isProcessing = false;
  }

  /**
   * Main scheduling loop - runs every 5 seconds
   * Only executes if this instance is the leader
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async runSchedulingLoop(): Promise<void> {
    // Guard: Scheduler must be enabled
    if (!this.enabled) {
      return;
    }

    // Guard: Only leader processes workflows
    if (!this.leaderElection.isLeader) {
      this.logger.debug('Skipping workflow processing - not the leader');
      return;
    }

    // Guard: Prevent overlapping executions
    if (this.isProcessing) {
      this.logger.warn('Previous processing still running, skipping this cycle');
      return;
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      await this.scheduleReadyNodes();
      await this.checkCompletedNodes();
      await this.checkWorkflowCompletion();

      const duration = Date.now() - startTime;
      if (duration > 1000) {
        this.logger.log(`Scheduling loop completed in ${duration}ms`);
      }
    } catch (error: any) {
      this.logger.error(`Scheduling loop error: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Get scheduler status for monitoring
   */
  getSchedulerStatus(): {
    enabled: boolean;
    isLeader: boolean;
    isProcessing: boolean;
    batchSize: number;
  } {
    return {
      enabled: this.enabled,
      isLeader: this.leaderElection.isLeader,
      isProcessing: this.isProcessing,
      batchSize: this.batchSize,
    };
  }

  /**
   * Find and dispatch ready nodes using FOR UPDATE SKIP LOCKED
   */
  private async scheduleReadyNodes(): Promise<void> {
    // Use raw query for FOR UPDATE SKIP LOCKED support
    // Note: Uses schema-qualified table names (workflow_orchestrator.workflow_nodes)
    const readyNodes = await this.prisma.$queryRaw<any[]>`
      SELECT wn.*
      FROM workflow_orchestrator.workflow_nodes wn
      JOIN workflow_orchestrator.workflow_runs wr ON wn.workflow_run_id = wr.id
      WHERE wn.status = 'READY'
        AND wr.status = 'RUNNING'
      ORDER BY wn."order" ASC
      LIMIT ${this.batchSize}
      FOR UPDATE OF wn SKIP LOCKED
    `;

    if (readyNodes.length === 0) {
      return;
    }

    this.logger.debug(`Found ${readyNodes.length} ready nodes to schedule`);

    // Process each node
    for (const node of readyNodes) {
      await this.dispatchNode(node);
    }
  }

  /**
   * Dispatch a node for execution
   * v1.0.5: When poll-based dispatch is enabled, skip push-based NodeExecutor calls
   * (TaskDispatchService handles execution via workflow.node-ready events)
   */
  private async dispatchNode(node: any): Promise<void> {
    // v1.0.5: Skip push-based dispatch when poll-based is enabled
    // TaskDispatchService listens to workflow.node-ready events and creates tasks
    // in the agent system. Agents then poll and claim those tasks.
    if (this.pollBasedDispatch) {
      this.logger.debug(`Skipping push-based dispatch for node ${node.id} (poll-based dispatch enabled)`);
      // Node stays in READY status - TaskDispatchService will handle it
      // via the workflow.node-ready event emitted by orchestrator-loop
      return;
    }

    try {
      // Mark node as RUNNING
      await this.prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: NodeStatus.RUNNING,
          startedAt: new Date(),
        },
      });

      // Get workflow for workspace info
      // v1.0.4: Use snake_case column name from raw SQL query result
      const workflowRunId = node.workflow_run_id;
      const workflow = await this.prisma.workflowRun.findUnique({
        where: { id: workflowRunId },
        include: { workspace: true },
      });

      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowRunId}`);
      }

      // Acquire workspace lock
      const lockAcquired = await this.workspaceService.acquireLock(
        workflow.workspaceId,
        node.id,
        300000, // 5 minute lock
      );

      if (!lockAcquired) {
        this.logger.warn(`Could not acquire lock for workspace ${workflow.workspaceId}`);
        // Revert to READY status
        await this.prisma.workflowNode.update({
          where: { id: node.id },
          data: { status: NodeStatus.READY, startedAt: null },
        });
        return;
      }

      // Execute the node (async) - push-based to registered agents
      this.nodeExecutor.executeNode(node, workflow).catch((error) => {
        this.logger.error(`Node ${node.id} execution error: ${error.message}`);
      });

      this.eventEmitter.emit('node.dispatched', {
        nodeId: node.id,
        workflowId: workflowRunId,
      });
    } catch (error: any) {
      this.logger.error(`Failed to dispatch node ${node.id}: ${error.message}`);

      // Mark node as failed
      await this.prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: NodeStatus.FAILED,
          error: error.message,
          completedAt: new Date(),
        },
      });
    }
  }

  /**
   * Check for completed nodes and resolve dependencies
   */
  private async checkCompletedNodes(): Promise<void> {
    // Find nodes that have completed and may unblock others
    const completedNodes = await this.prisma.workflowNode.findMany({
      where: {
        status: { in: [NodeStatus.COMPLETED, NodeStatus.FAILED] },
        dependencyResolved: false,
      },
      include: {
        workflowRun: true,
      },
    });

    for (const node of completedNodes) {
      await this.resolveDependencies(node);
    }
  }

  /**
   * Resolve dependencies after a node completes
   */
  private async resolveDependencies(completedNode: any): Promise<void> {
    // Find nodes that depend on this one
    const dependentNodes = await this.prisma.workflowNode.findMany({
      where: {
        workflowRunId: completedNode.workflowRunId,
        status: NodeStatus.PENDING,
        dependencies: { has: completedNode.id },
      },
    });

    for (const dependentNode of dependentNodes) {
      // Check if all dependencies are satisfied
      const allDependencies = dependentNode.dependencies as string[];
      const completedDeps = await this.prisma.workflowNode.count({
        where: {
          id: { in: allDependencies },
          status: NodeStatus.COMPLETED,
        },
      });

      if (completedDeps === allDependencies.length) {
        // All dependencies satisfied - mark as READY
        await this.prisma.workflowNode.update({
          where: { id: dependentNode.id },
          data: { status: NodeStatus.READY },
        });

        this.logger.debug(`Node ${dependentNode.id} is now READY`);
      }
    }

    // Mark this node's dependencies as resolved
    await this.prisma.workflowNode.update({
      where: { id: completedNode.id },
      data: { dependencyResolved: true },
    });
  }

  /**
   * Check if any workflows have completed
   */
  private async checkWorkflowCompletion(): Promise<void> {
    // Find running workflows with all nodes completed
    const runningWorkflows = await this.prisma.workflowRun.findMany({
      where: { status: WorkflowStatus.RUNNING },
      include: {
        nodes: true,
      },
    });

    for (const workflow of runningWorkflows) {
      const allNodesCompleted = workflow.nodes.every(
        (n) =>
          n.status === NodeStatus.COMPLETED ||
          n.status === NodeStatus.SKIPPED ||
          n.status === NodeStatus.FAILED,
      );

      if (!allNodesCompleted) {
        continue;
      }

      // Determine final status
      const hasFailedNodes = workflow.nodes.some(
        (n) => n.status === NodeStatus.FAILED,
      );

      const finalStatus = hasFailedNodes
        ? WorkflowStatus.FAILED
        : WorkflowStatus.COMPLETED;

      const failedNode = workflow.nodes.find(
        (n) => n.status === NodeStatus.FAILED,
      );

      await this.workflowService.completeWorkflow(
        workflow.id,
        finalStatus,
        hasFailedNodes ? `Node ${failedNode?.name} failed: ${failedNode?.error}` : undefined,
      );
    }
  }
}
