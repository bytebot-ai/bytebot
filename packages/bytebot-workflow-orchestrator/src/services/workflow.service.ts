/**
 * Workflow Service
 * v1.5.0: DB-driven retry gating with nextAttemptAt field (prevents tight loop)
 * v1.4.0: Hardened capacity check to use K8s as source of truth
 * v1.3.0: Added proactive capacity check with MAX_ACTIVE_WORKSPACES_GLOBAL
 * v1.2.0: Fixed orphan pod bug - hibernation with retry and GC tracking
 * v1.1.0: Fixed runaway loop bug - link first, provision second pattern
 *
 * Responsibilities:
 * - Create and manage workflow runs
 * - Track workflow state transitions
 * - Coordinate with workspace and scheduler services
 *
 * Key Change (v1.4.0):
 * - checkCapacity() now queries K8s pod count (source of truth)
 * - Falls back to DB count if K8s unreachable
 * - Logs warning if DB/K8s counts diverge
 *
 * Key Change (v1.3.0):
 * - Added checkCapacity() to proactively check before provisioning
 * - Respects MAX_ACTIVE_WORKSPACES_GLOBAL limit (default: 6)
 * - Returns WAITING_FOR_CAPACITY before hitting cluster scheduling limits
 *
 * Key Change (v1.2.0):
 * - Added hibernateWorkspaceWithTracking() with exponential backoff retry
 * - Marks failed hibernations as HIBERNATION_FAILED for GC cleanup
 * - completeWorkflow() and cancelWorkflow() now never throw on hibernation failure
 *
 * Key Change (v1.1.0):
 * - Separated createWorkflowRecord (DB-only) from workspace provisioning
 * - Added workspace provisioning status tracking to prevent infinite loops
 * - Implemented idempotent workflow creation per Kubebuilder best practices
 *
 * @see https://book.kubebuilder.io/reference/good-practices
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { WorkspaceService } from './workspace.service';
import { WorkspaceDbReconcilerService } from './workspace-db-reconciler.service';
import { createId } from '@paralleldrive/cuid2';

// Workflow statuses
export enum WorkflowStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

// Node statuses
export enum NodeStatus {
  PENDING = 'PENDING',
  READY = 'READY',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED',
}

// v1.1.0: Workspace provisioning statuses for idempotency
export enum WorkspaceProvisioningStatus {
  PENDING = 'PENDING',
  CREATING = 'CREATING',
  READY = 'READY',
  FAILED = 'FAILED',
  WAITING_FOR_CAPACITY = 'WAITING_FOR_CAPACITY',
}

export interface CreateWorkflowInput {
  tenantId: string;
  workflowTemplateId?: string;
  name?: string;
  description?: string;
  nodes: WorkflowNodeInput[];
  persistence?: {
    enabled: boolean;
    storageClass?: string;
    size?: string;
  };
}

export interface WorkflowNodeInput {
  id?: string;
  name: string;
  type: 'TASK' | 'DECISION' | 'PARALLEL' | 'WAIT';
  config: Record<string, any>;
  dependencies?: string[];
}

export interface WorkflowRunResult {
  id: string;
  workspaceId: string;
  status: WorkflowStatus;
  nodes: any[];
  createdAt: Date;
}

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
  // v1.3.0: Hard cap on active workspaces to prevent cluster capacity exhaustion
  // With only 3 desktop-capable nodes, we can safely run ~6 workspace pods max
  // (2 per node, leaving headroom for pool pods and system pods)
  private readonly maxActiveWorkspaces: number;

  constructor(
    private prisma: PrismaService,
    private workspaceService: WorkspaceService,
    private eventEmitter: EventEmitter2,
    private configService: ConfigService,
    @Inject(forwardRef(() => WorkspaceDbReconcilerService))
    private workspaceDbReconciler: WorkspaceDbReconcilerService,
  ) {
    // v1.3.0: Load max workspaces from config (default: 6 for 3-node cluster)
    this.maxActiveWorkspaces = parseInt(
      this.configService.get<string>('MAX_ACTIVE_WORKSPACES_GLOBAL', '6'),
      10,
    );
    this.logger.log(`Max active workspaces set to ${this.maxActiveWorkspaces}`);
  }

  /**
   * v1.1.0: Create workflow record only (DB operation)
   *
   * This is the idempotent first step - creates only DB records:
   * 1. A Workspace record (with provisioning status = PENDING)
   * 2. A WorkflowRun record
   * 3. WorkflowNode records for each node
   *
   * Workspace provisioning happens separately via ensureWorkspaceProvisioned()
   * This separation prevents the runaway loop bug where failed provisioning
   * caused new workflows to be created on each loop iteration.
   *
   * @see Phase 2 fix: https://book.kubebuilder.io/reference/good-practices
   */
  async createWorkflowRecord(input: CreateWorkflowInput): Promise<WorkflowRunResult> {
    const workflowId = `wf-${createId()}`;
    const workspaceId = `ws-${createId()}`;

    this.logger.log(`Creating workflow record ${workflowId} with workspace ${workspaceId} (DB only, no provisioning)`);

    // Use transaction to ensure atomicity of DB records
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Create Workspace record with PENDING provisioning status
      const workspace = await tx.workspace.create({
        data: {
          id: workspaceId,
          tenantId: input.tenantId,
          status: WorkspaceProvisioningStatus.PENDING,
          lockedBy: null,
          lockedAt: null,
          persistenceEnabled: input.persistence?.enabled ?? true,
          storageClass: input.persistence?.storageClass || 'longhorn',
          storageSize: input.persistence?.size || '10Gi',
          // v1.1.0: Provisioning tracking fields
          provisioningAttemptCount: 0,
          lastProvisioningAttemptAt: null,
        },
      });

      // 2. Create WorkflowRun record
      const workflowRun = await tx.workflowRun.create({
        data: {
          id: workflowId,
          workspaceId,
          tenantId: input.tenantId,
          templateId: input.workflowTemplateId,
          name: input.name || `Workflow ${workflowId}`,
          description: input.description,
          status: WorkflowStatus.PENDING,
        },
      });

      // 3. Create WorkflowNode records
      const nodes = await Promise.all(
        input.nodes.map(async (node, index) => {
          const nodeId = node.id || `node-${createId()}`;
          return tx.workflowNode.create({
            data: {
              id: nodeId,
              workflowRunId: workflowId,
              name: node.name,
              type: node.type,
              config: node.config,
              dependencies: node.dependencies || [],
              order: index,
              status: NodeStatus.PENDING,
            },
          });
        }),
      );

      return { workspace, workflowRun, nodes };
    });

    // Emit workflow created event (record only, not provisioned yet)
    this.eventEmitter.emit('workflow.record-created', {
      workflowId,
      workspaceId,
      tenantId: input.tenantId,
    });

    this.logger.log(`Workflow record ${workflowId} created successfully (awaiting provisioning)`);

    return {
      id: workflowId,
      workspaceId,
      status: WorkflowStatus.PENDING,
      nodes: result.nodes,
      createdAt: result.workflowRun.createdAt,
    };
  }

  /**
   * v1.1.0: Ensure workspace is provisioned (idempotent)
   *
   * This method handles workspace desktop provisioning with:
   * - Idempotency: Only provisions if status is PENDING or WAITING_FOR_CAPACITY
   * - State tracking: Updates provisioning attempt count and timestamps
   * - Capacity detection: Returns special status for capacity issues (not failure)
   *
   * Returns the provisioning result with status and backoff hint for capacity issues.
   */
  async ensureWorkspaceProvisioned(
    workflowId: string,
    tenantId: string,
    persistence?: { enabled?: boolean; storageClass?: string; size?: string },
  ): Promise<{
    success: boolean;
    status: WorkspaceProvisioningStatus;
    retryAfterMs?: number;
    error?: string;
  }> {
    // Get workflow and workspace
    const workflow = await this.prisma.workflowRun.findUnique({
      where: { id: workflowId },
      include: { workspace: true },
    });

    if (!workflow || !workflow.workspace) {
      return {
        success: false,
        status: WorkspaceProvisioningStatus.FAILED,
        error: `Workflow ${workflowId} not found or has no workspace`,
      };
    }

    const workspace = workflow.workspace;
    const currentStatus = workspace.status as WorkspaceProvisioningStatus;

    // Idempotency check: If already READY, return success
    if (currentStatus === WorkspaceProvisioningStatus.READY) {
      this.logger.debug(`Workspace ${workspace.id} already provisioned (idempotent skip)`);
      return { success: true, status: WorkspaceProvisioningStatus.READY };
    }

    // If already FAILED, don't retry automatically
    if (currentStatus === WorkspaceProvisioningStatus.FAILED) {
      this.logger.warn(`Workspace ${workspace.id} previously failed provisioning`);
      return {
        success: false,
        status: WorkspaceProvisioningStatus.FAILED,
        error: workspace.error || 'Previous provisioning failed',
      };
    }

    // Calculate backoff for WAITING_FOR_CAPACITY
    const attemptCount = (workspace as any).provisioningAttemptCount || 0;
    const lastAttempt = (workspace as any).lastProvisioningAttemptAt;

    if (currentStatus === WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY && lastAttempt) {
      // Exponential backoff: 30s, 60s, 120s, 240s, capped at 300s (5 min)
      const baseBackoffMs = 30000;
      const backoffMs = Math.min(baseBackoffMs * Math.pow(2, attemptCount), 300000);
      const jitter = (Math.random() - 0.5) * 0.2 * backoffMs; // ±10% jitter
      const nextRetryAt = new Date(lastAttempt).getTime() + backoffMs + jitter;
      const now = Date.now();

      if (now < nextRetryAt) {
        const retryAfterMs = Math.ceil(nextRetryAt - now);
        this.logger.debug(
          `Workspace ${workspace.id} waiting for capacity, retry in ${Math.ceil(retryAfterMs / 1000)}s ` +
          `(attempt ${attemptCount + 1}, backoff ${Math.ceil(backoffMs / 1000)}s)`
        );
        return {
          success: false,
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          retryAfterMs,
        };
      }
    }

    // v1.3.0: Proactive capacity check BEFORE attempting provisioning
    // This prevents cluster scheduling failures by rejecting early
    const capacityCheck = await this.checkCapacity(workspace.id);
    if (!capacityCheck.hasCapacity) {
      // v1.5.0: Calculate nextAttemptAt for DB-driven retry gating
      // This prevents the orchestrator tight loop from rechecking every second
      const backoffMs = capacityCheck.backoffMs || 30000;
      const nextAttemptAt = new Date(Date.now() + backoffMs);

      // At capacity - update workspace status and return backoff hint
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          provisioningAttemptCount: attemptCount + 1,
          lastProvisioningAttemptAt: new Date(),
          nextAttemptAt, // v1.5.0: DB-driven retry gating
          error: `Capacity limit reached: ${capacityCheck.activeCount}/${capacityCheck.maxAllowed} active workspaces`,
        },
      });

      this.logger.warn(
        `Workspace ${workspace.id} rejected: capacity limit reached ` +
        `(${capacityCheck.activeCount}/${capacityCheck.maxAllowed}), retry at ${nextAttemptAt.toISOString()}`
      );

      return {
        success: false,
        status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
        retryAfterMs: backoffMs,
        error: `Capacity limit reached: ${capacityCheck.activeCount}/${capacityCheck.maxAllowed} active workspaces`,
      };
    }

    // Update status to CREATING and increment attempt count
    await this.prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        status: WorkspaceProvisioningStatus.CREATING,
        provisioningAttemptCount: attemptCount + 1,
        lastProvisioningAttemptAt: new Date(),
      },
    });

    this.logger.log(
      `Provisioning workspace ${workspace.id} (attempt ${attemptCount + 1})`
    );

    // Attempt provisioning
    try {
      await this.workspaceService.ensureWorkspaceDesktop(
        workspace.id,
        tenantId,
        persistence,
      );

      // Success - update status to READY and clear retry gating
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          status: WorkspaceProvisioningStatus.READY,
          nextAttemptAt: null, // v1.5.0: Clear retry gating on success
          error: null,
        },
      });

      this.logger.log(`Workspace ${workspace.id} provisioned successfully`);

      // Emit workflow created event (now fully provisioned)
      this.eventEmitter.emit('workflow.created', {
        workflowId,
        workspaceId: workspace.id,
        tenantId,
      });

      return { success: true, status: WorkspaceProvisioningStatus.READY };
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown provisioning error';
      this.logger.error(`Workspace ${workspace.id} provisioning failed: ${errorMessage}`);

      // Detect capacity issues (timeout, scheduling failure, resource exhaustion)
      const isCapacityIssue = this.isCapacityError(errorMessage);

      if (isCapacityIssue) {
        // Calculate next retry backoff
        const backoffMs = Math.min(30000 * Math.pow(2, attemptCount), 300000);
        // v1.5.0: Set nextAttemptAt for DB-driven retry gating
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        // Capacity issue - set WAITING_FOR_CAPACITY, not FAILED
        await this.prisma.workspace.update({
          where: { id: workspace.id },
          data: {
            status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
            nextAttemptAt, // v1.5.0: DB-driven retry gating
            error: errorMessage,
          },
        });

        this.logger.warn(
          `Workspace ${workspace.id} waiting for capacity (attempt ${attemptCount + 1}), ` +
          `retry at ${nextAttemptAt.toISOString()}`
        );

        return {
          success: false,
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          retryAfterMs: backoffMs,
          error: errorMessage,
        };
      }

      // Non-capacity error - mark as FAILED
      await this.prisma.workspace.update({
        where: { id: workspace.id },
        data: {
          status: WorkspaceProvisioningStatus.FAILED,
          error: errorMessage,
        },
      });

      // Also mark workflow as failed
      await this.prisma.workflowRun.update({
        where: { id: workflowId },
        data: {
          status: WorkflowStatus.FAILED,
          error: `Workspace creation failed: ${errorMessage}`,
          completedAt: new Date(),
        },
      });

      return {
        success: false,
        status: WorkspaceProvisioningStatus.FAILED,
        error: errorMessage,
      };
    }
  }

  /**
   * v1.1.0: Detect if an error is a capacity/scheduling issue
   * These should trigger WAITING_FOR_CAPACITY, not FAILED
   */
  private isCapacityError(errorMessage: string): boolean {
    const capacityPatterns = [
      /timeout/i,
      /pod not ready/i,
      /insufficient/i,
      /unschedulable/i,
      /no nodes available/i,
      /exceeds available/i,
      /quota exceeded/i,
      /too many requests/i,
      /429/i,
      /deadline/i,
      /capacity/i,
    ];
    return capacityPatterns.some(pattern => pattern.test(errorMessage));
  }

  /**
   * v1.3.0: Proactively check if we have capacity for a new workspace
   *
   * This prevents scheduling failures by checking BEFORE attempting provisioning.
   * Returns { hasCapacity: true } if we can provision, or { hasCapacity: false }
   * with suggested backoff time if at capacity.
   *
   * v1.4.0: Active workspaces counted from K8s pods (source of truth)
   * Falls back to DB count if K8s is unreachable
   * Logs warning if DB and K8s counts diverge (indicates drift)
   */
  private async checkCapacity(excludeWorkspaceId?: string): Promise<{
    hasCapacity: boolean;
    activeCount: number;
    maxAllowed: number;
    backoffMs?: number;
    source: 'k8s' | 'db';
  }> {
    let k8sCount: number | null = null;
    let dbCount: number;

    // v1.4.0: Try K8s first (source of truth)
    try {
      k8sCount = await this.workspaceDbReconciler.getK8sActiveWorkspaceCount();
    } catch (error: any) {
      this.logger.warn(
        `K8s unreachable for capacity check, falling back to DB: ${error.message}`,
      );
    }

    // Always get DB count for comparison
    const whereClause: any = {
      status: {
        in: [
          WorkspaceProvisioningStatus.READY,
          WorkspaceProvisioningStatus.CREATING,
        ],
      },
    };

    if (excludeWorkspaceId) {
      whereClause.id = { not: excludeWorkspaceId };
    }

    dbCount = await this.prisma.workspace.count({
      where: whereClause,
    });

    // Use K8s count if available, otherwise fall back to DB
    const activeCount = k8sCount !== null ? k8sCount : dbCount;
    const source = k8sCount !== null ? 'k8s' : 'db';

    // v1.4.0: Warn if counts diverge - this indicates drift
    if (k8sCount !== null && k8sCount !== dbCount) {
      this.logger.warn(
        `Workspace count drift detected: K8s=${k8sCount}, DB=${dbCount} ` +
        `(using K8s as source of truth). Reconciler will fix this.`,
      );
    }

    const hasCapacity = activeCount < this.maxActiveWorkspaces;

    if (!hasCapacity) {
      this.logger.warn(
        `Capacity check failed (${source}): ${activeCount}/${this.maxActiveWorkspaces} active workspaces`,
      );
    } else {
      this.logger.debug(
        `Capacity check passed (${source}): ${activeCount}/${this.maxActiveWorkspaces} active workspaces`,
      );
    }

    return {
      hasCapacity,
      activeCount,
      maxAllowed: this.maxActiveWorkspaces,
      backoffMs: hasCapacity ? undefined : 30000,
      source,
    };
  }

  /**
   * v1.2.0: Helper to retry an async operation with exponential backoff
   *
   * Implements best practices:
   * - Exponential backoff with jitter to prevent thundering herd
   * - Configurable max retries
   * - Returns result or throws after all retries exhausted
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      operationName?: string;
    } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 1000;
    const maxDelayMs = options.maxDelayMs ?? 10000;
    const operationName = options.operationName ?? 'operation';

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (attempt === maxRetries) {
          this.logger.error(
            `${operationName} failed after ${maxRetries + 1} attempts: ${error.message}`,
          );
          throw error;
        }

        // Exponential backoff with jitter (±25%)
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        const jitter = delay * (0.5 + Math.random() * 0.5); // 50-100% of delay
        const finalDelay = Math.floor(jitter);

        this.logger.warn(
          `${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${finalDelay}ms: ${error.message}`,
        );

        await new Promise((resolve) => setTimeout(resolve, finalDelay));
      }
    }

    throw lastError;
  }

  /**
   * v1.2.0: Helper to hibernate workspace with retry and error tracking
   *
   * This method:
   * 1. Attempts hibernation with exponential backoff
   * 2. Updates workspace status on success
   * 3. On failure, marks workspace for GC cleanup (HIBERNATION_FAILED status)
   * 4. Never throws - returns success/failure result
   *
   * This prevents orphan pods by:
   * - Retrying transient failures
   * - Tracking failed hibernations for GC service cleanup
   */
  private async hibernateWorkspaceWithTracking(
    workspaceId: string,
    workflowId: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Get current attempt count
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { hibernationAttemptCount: true },
    });

    const attemptCount = (workspace?.hibernationAttemptCount ?? 0) + 1;

    // Update attempt tracking before trying
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        hibernationAttemptCount: attemptCount,
        lastHibernationAttemptAt: new Date(),
      },
    });

    try {
      // Attempt hibernation with retry
      await this.withRetry(
        () => this.workspaceService.hibernateWorkspace(workspaceId),
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          maxDelayMs: 5000,
          operationName: `hibernateWorkspace(${workspaceId})`,
        },
      );

      // Success - update status
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'HIBERNATED',
          hibernationError: null,
        },
      });

      this.logger.log(`Workspace ${workspaceId} hibernated successfully`);
      return { success: true };
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown hibernation error';

      // Mark for GC cleanup - workspace pod may still be running
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'HIBERNATION_FAILED',
          hibernationError: errorMessage,
        },
      });

      this.logger.error(
        `Workspace ${workspaceId} hibernation failed after ${attemptCount} attempts: ${errorMessage}. ` +
        `Marked for GC cleanup.`,
        { workflowId, workspaceId, attemptCount },
      );

      // Emit event for monitoring/alerting
      this.eventEmitter.emit('workspace.hibernation-failed', {
        workspaceId,
        workflowId,
        attemptCount,
        error: errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Create a new workflow run (legacy method - now calls createWorkflowRecord + ensureWorkspaceProvisioned)
   *
   * This creates:
   * 1. A Workspace record (with lock fields)
   * 2. A WorkflowRun record
   * 3. WorkflowNode records for each node
   * 4. Requests a persistent desktop from task-controller
   *
   * @deprecated Use createWorkflowRecord() + ensureWorkspaceProvisioned() for better idempotency
   */
  async createWorkflow(input: CreateWorkflowInput): Promise<WorkflowRunResult> {
    // Create DB records first
    const result = await this.createWorkflowRecord(input);

    // Then provision workspace (may fail, but workflow record exists)
    const provisionResult = await this.ensureWorkspaceProvisioned(
      result.id,
      input.tenantId,
      input.persistence,
    );

    if (!provisionResult.success && provisionResult.status === WorkspaceProvisioningStatus.FAILED) {
      throw new Error(provisionResult.error || 'Workspace provisioning failed');
    }

    return result;
  }

  /**
   * Get workflow run by ID
   */
  async getWorkflow(workflowId: string): Promise<any> {
    return this.prisma.workflowRun.findUnique({
      where: { id: workflowId },
      include: {
        nodes: {
          orderBy: { order: 'asc' },
        },
        workspace: true,
      },
    });
  }

  /**
   * Start workflow execution
   */
  async startWorkflow(workflowId: string): Promise<void> {
    this.logger.log(`Starting workflow ${workflowId}`);

    await this.prisma.workflowRun.update({
      where: { id: workflowId },
      data: {
        status: WorkflowStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    // Mark nodes with no dependencies as READY
    await this.prisma.workflowNode.updateMany({
      where: {
        workflowRunId: workflowId,
        status: NodeStatus.PENDING,
        dependencies: { equals: [] },
      },
      data: { status: NodeStatus.READY },
    });

    this.eventEmitter.emit('workflow.started', { workflowId });
  }

  /**
   * Complete workflow
   *
   * v1.2.0: Uses hibernateWorkspaceWithTracking() to prevent orphan pods
   * - Retries hibernation with exponential backoff
   * - Marks failed hibernations for GC cleanup
   * - Never throws on hibernation failure (workflow is already complete)
   */
  async completeWorkflow(
    workflowId: string,
    status: WorkflowStatus.COMPLETED | WorkflowStatus.FAILED,
    error?: string,
  ): Promise<void> {
    this.logger.log(`Completing workflow ${workflowId} with status ${status}`);

    const workflow = await this.prisma.workflowRun.update({
      where: { id: workflowId },
      data: {
        status,
        error,
        completedAt: new Date(),
      },
      include: { workspace: true },
    });

    // v1.2.0: Hibernate with retry and error tracking (prevents orphan pods)
    if (workflow.workspace) {
      // This method never throws - marks for GC cleanup on failure
      await this.hibernateWorkspaceWithTracking(workflow.workspaceId, workflowId);
    }

    this.eventEmitter.emit('workflow.completed', {
      workflowId,
      status,
      error,
    });
  }

  /**
   * Cancel workflow
   *
   * v1.2.0: Uses hibernateWorkspaceWithTracking() to prevent orphan pods
   * - Retries hibernation with exponential backoff
   * - Marks failed hibernations for GC cleanup
   * - Never throws on hibernation failure (workflow is already cancelled)
   */
  async cancelWorkflow(workflowId: string, reason?: string): Promise<void> {
    this.logger.log(`Cancelling workflow ${workflowId}: ${reason}`);

    const workflow = await this.prisma.workflowRun.update({
      where: { id: workflowId },
      data: {
        status: WorkflowStatus.CANCELLED,
        error: reason || 'Cancelled by user',
        completedAt: new Date(),
      },
      include: { workspace: true },
    });

    // Cancel any running nodes
    await this.prisma.workflowNode.updateMany({
      where: {
        workflowRunId: workflowId,
        status: { in: [NodeStatus.PENDING, NodeStatus.READY, NodeStatus.RUNNING] },
      },
      data: { status: NodeStatus.SKIPPED },
    });

    // v1.2.0: Hibernate with retry and error tracking (prevents orphan pods)
    if (workflow.workspace) {
      // This method never throws - marks for GC cleanup on failure
      await this.hibernateWorkspaceWithTracking(workflow.workspaceId, workflowId);
    }

    this.eventEmitter.emit('workflow.cancelled', { workflowId, reason });
  }
}
