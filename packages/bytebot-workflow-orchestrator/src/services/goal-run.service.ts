/**
 * Goal Run Service
 * v1.0.1: Fixed startGoalRun to not pre-set PLANNING phase (allows orchestrator atomic transition)
 * v1.0.0: Manus-style goal-first orchestration
 *
 * Responsibilities:
 * - Create and manage goal runs
 * - Track goal run state transitions
 * - Coordinate with planner, executor, verifier services
 * - Manage the orchestrator loop lifecycle
 *
 * Phase Transition Fix (v1.0.1):
 * - startGoalRun no longer sets phase to PLANNING
 * - Leaves phase as INITIALIZING for orchestrator loop to handle atomically
 * - Prevents race condition regression where planning never starts
 */

import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { WorkflowService } from './workflow.service';
import { createId } from '@paralleldrive/cuid2';
import {
  GoalRunExecutionEngine,
  GoalRunPhase,
  GoalRunStatus,
  ChecklistItemStatus,
  ExecutionSurface,
  Prisma,
  StepType,
} from '@prisma/client';
import { TemporalWorkflowService } from '../temporal/temporal-workflow.service';
import { FeatureFlagService } from '../temporal/feature-flag.service';
import { hasUserInteractionTool } from '../contracts/planner-tools';
import { TemporalCapabilityProbeService } from '../temporal/temporal-capability-probe.service';

// Re-export enums for convenience
export { GoalRunPhase, GoalRunStatus, ChecklistItemStatus };

// Input types
export interface CreateGoalRunInput {
  tenantId: string;
  goal: string;
  constraints?: GoalConstraints;
  autoStart?: boolean;
}

export interface GoalConstraints {
  workspaceMode?: 'EXCLUSIVE' | 'SHARED';
  allowedTools?: string[];
  riskPolicy?: {
    requireApproval?: string[];
    blockTools?: string[];
  };
  deadlineMinutes?: number;
}

export interface SteeringInput {
  type: 'PAUSE' | 'RESUME' | 'CANCEL' | 'MODIFY_PLAN' | 'APPROVE' | 'REJECT' | 'INSTRUCTION';
  content?: string;
  targetItemId?: string;
  userId?: string;
  userEmail?: string;
}

// Response types
export interface GoalRunResponse {
  id: string;
  tenantId: string;
  goal: string;
  constraints: GoalConstraints;
  phase: GoalRunPhase;
  status: GoalRunStatus;
  executionEngine: GoalRunExecutionEngine;
  workflowRunId?: string | null;
  temporalWorkflowId?: string | null;
  temporalRunId?: string | null;
  temporalStartedAt?: Date | null;
  currentPlanVersion: number;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface GoalRunWithPlan extends GoalRunResponse {
  currentPlan?: {
    version: number;
    summary?: string | null;
    items: ChecklistItemResponse[];
  };
  progress: {
    completed: number;
    total: number;
  };
}

export interface ChecklistItemResponse {
  id: string;
  order: number;
  description: string;
  status: ChecklistItemStatus;
  type?: StepType;
  suggestedTools?: string[];
  requiresDesktop?: boolean;
  executionSurface?: ExecutionSurface;
  // Derived, explicit “external input required” signal for clients/UI (legacy-safe).
  isExternalInput?: boolean;
  // True when `suggestedTools=["ASK_USER"]` is present but type is not USER_INPUT_REQUIRED.
  // This indicates a pre-fix misclassification that should be rendered as a prompt in UI.
  isLegacyPromptStep?: boolean;
  expectedOutcome?: string | null;
  actualOutcome?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface PlanVersionResponse {
  id: string;
  version: number;
  summary?: string | null;
  replanReason?: string | null;
  confidence?: number | null;
  createdAt: Date;
  items: ChecklistItemResponse[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface GoalRunFilters {
  status?: GoalRunStatus;
  phase?: GoalRunPhase;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class GoalRunService {
  private readonly logger = new Logger(GoalRunService.name);

  constructor(
    private prisma: PrismaService,
    private workflowService: WorkflowService,
    private eventEmitter: EventEmitter2,
    @Optional() private temporalWorkflowService?: TemporalWorkflowService,
    @Optional() private featureFlagService?: FeatureFlagService,
    @Optional() private temporalCapabilityProbeService?: TemporalCapabilityProbeService,
  ) {}

  /**
   * Check if Temporal workflow should be used for this goal run
   */
  private shouldUseTemporalWorkflow(goalRunId: string, tenantId: string, goal?: string): boolean {
    if (!this.temporalWorkflowService?.isEnabled() || !this.featureFlagService) {
      return false;
    }

    // Defense-in-depth: if the Temporal capability probe is red, do not route new runs to Temporal.
    if (this.temporalCapabilityProbeService && !this.temporalCapabilityProbeService.isHealthyForTraffic()) {
      const reason = this.temporalCapabilityProbeService.getLastError() ?? 'unknown';
      this.logger.warn(`Temporal capability probe is red; routing ${goalRunId} to legacy. reason=${reason}`);
      return false;
    }

    const result = this.featureFlagService.shouldUseTemporalWorkflow({
      goalRunId,
      tenantId,
      goalDescription: goal,
    });

    if (result.enabled) {
      this.logger.log(`Using Temporal workflow for ${goalRunId}: ${result.reason}`);
    }

    return result.enabled;
  }

  /**
   * Create a new goal run from a natural language goal
   */
  async createFromGoal(input: CreateGoalRunInput): Promise<GoalRunResponse> {
    const goalRunId = `gr-${createId()}`;

    this.logger.log(`Creating goal run ${goalRunId} for goal: "${input.goal.substring(0, 50)}..."`);

    const executionEngine = this.shouldUseTemporalWorkflow(goalRunId, input.tenantId, input.goal)
      ? GoalRunExecutionEngine.TEMPORAL_WORKFLOW
      : GoalRunExecutionEngine.LEGACY_DB_LOOP;

    const temporalWorkflowId =
      executionEngine === GoalRunExecutionEngine.TEMPORAL_WORKFLOW && this.temporalWorkflowService
        ? this.temporalWorkflowService.getWorkflowId(goalRunId)
        : null;

    const goalRun = await this.prisma.goalRun.create({
      data: {
        id: goalRunId,
        tenantId: input.tenantId,
        goal: input.goal,
        constraints: (input.constraints || {}) as object,
        phase: GoalRunPhase.INITIALIZING,
        status: GoalRunStatus.PENDING,
        currentPlanVersion: 0,
        executionEngine,
        ...(temporalWorkflowId ? { temporalWorkflowId } : {}),
      },
    });

    // Emit goal created event
    this.eventEmitter.emit('goal-run.created', {
      goalRunId,
      tenantId: input.tenantId,
      goal: input.goal,
    });

    // Create activity event
    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_CREATED',
      title: 'Goal run created',
      description: `Goal: ${input.goal}`,
    });

    // Auto-start if requested
    if (input.autoStart !== false) {
      await this.startGoalRun(goalRunId);
    }

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Get goal run by ID
   */
  async findById(goalRunId: string): Promise<GoalRunResponse> {
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${goalRunId} not found`);
    }

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Get goal run with current plan
   */
  async findByIdWithPlan(goalRunId: string): Promise<GoalRunWithPlan> {
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
      throw new NotFoundException(`Goal run ${goalRunId} not found`);
    }

    const currentPlanVersion = goalRun.planVersions[0];
    const items = currentPlanVersion?.checklistItems || [];

    const completedCount = items.filter(
      (item) => item.status === ChecklistItemStatus.COMPLETED,
    ).length;

    return {
      ...this.toGoalRunResponse(goalRun),
      currentPlan: currentPlanVersion
        ? {
            version: currentPlanVersion.version,
            summary: currentPlanVersion.summary,
            items: items.map(this.toChecklistItemResponse),
          }
        : undefined,
      progress: {
        completed: completedCount,
        total: items.length,
      },
    };
  }

  /**
   * List goal runs for a tenant
   */
  async findByTenant(
    tenantId: string,
    filters?: GoalRunFilters,
  ): Promise<PaginatedResponse<GoalRunResponse>> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.GoalRunWhereInput = {
      tenantId,
      ...(filters?.status && { status: filters.status }),
      ...(filters?.phase && { phase: filters.phase }),
    };

    const [goalRuns, total] = await Promise.all([
      this.prisma.goalRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.goalRun.count({ where }),
    ]);

    return {
      data: goalRuns.map(this.toGoalRunResponse),
      total,
      page,
      pageSize,
      hasMore: skip + goalRuns.length < total,
    };
  }

  /**
   * Start goal run execution
   * v1.0.1: No longer sets phase to PLANNING - lets orchestrator handle phase transition atomically
   * v1.1.0: Added Temporal workflow support with feature flag
   * v5.18.12: Execution engine is pinned at creation (no per-start routing)
   */
  async startGoalRun(goalRunId: string): Promise<GoalRunResponse> {
    this.logger.log(`Starting goal run ${goalRunId}`);

    const existingGoalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    if (!existingGoalRun) {
      throw new NotFoundException(`Goal run ${goalRunId} not found`);
    }

    const executionEngine =
      existingGoalRun.executionEngine ?? GoalRunExecutionEngine.LEGACY_DB_LOOP;

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: GoalRunStatus.RUNNING,
        // v1.0.1: Don't set phase here - leave as INITIALIZING
        // The orchestrator loop will atomically transition INITIALIZING -> PLANNING
        // This prevents race conditions where multiple iterations try to plan
        startedAt: new Date(),
      },
    });

    if (
      executionEngine === GoalRunExecutionEngine.TEMPORAL_WORKFLOW &&
      (!this.temporalWorkflowService || !this.temporalWorkflowService.isEnabled())
    ) {
      const error = 'Run execution_engine=TEMPORAL_WORKFLOW but Temporal workflows are disabled';

      this.logger.error(`${error} (goalRunId=${goalRunId})`);

      await this.createActivityEvent(goalRunId, {
        eventType: 'TEMPORAL_ENGINE_DISABLED',
        title: 'Temporal workflow engine disabled',
        description: error,
        severity: 'error',
      });

      const failed = await this.prisma.goalRun.update({
        where: { id: goalRunId },
        data: { status: GoalRunStatus.FAILED, phase: GoalRunPhase.FAILED, error },
      });

      return this.toGoalRunResponse(failed);
    }

    // Start Temporal workflow if engine is pinned to TEMPORAL_WORKFLOW
    if (executionEngine === GoalRunExecutionEngine.TEMPORAL_WORKFLOW && this.temporalWorkflowService) {
      // Idempotency: if we already recorded Temporal workflow identifiers, do not start a second workflow.
      if (existingGoalRun.temporalStartedAt || existingGoalRun.temporalRunId) {
        this.logger.log(
          `Temporal workflow already started for ${goalRunId}: ${existingGoalRun.temporalWorkflowId ?? this.temporalWorkflowService.getWorkflowId(goalRunId)} (run: ${existingGoalRun.temporalRunId ?? 'unknown'})`,
        );
      } else {
      try {
        const constraints = goalRun.constraints as GoalConstraints;
        const { workflowId, runId } = await this.temporalWorkflowService.startGoalRunWorkflow({
          goalRunId,
          tenantId: goalRun.tenantId,
          userId: 'system', // TODO: Pass actual user ID from context
          goalDescription: goalRun.goal,
          constraints: {
            maxSteps: 50,
            maxRetries: 3,
            maxReplans: 5,
            timeoutMs: constraints?.deadlineMinutes ? constraints.deadlineMinutes * 60 * 1000 : 3600000,
            requireApprovalForHighRisk: constraints?.riskPolicy?.requireApproval?.length ? true : false,
          },
        });

        this.logger.log(`Temporal workflow started: ${workflowId} (run: ${runId})`);

        // Persist Temporal identifiers for audit/debug (write-once semantics).
        const temporalStartedAt = new Date();
        await this.prisma.goalRun.updateMany({
          where: {
            id: goalRunId,
            temporalRunId: null,
          },
          data: {
            temporalWorkflowId: workflowId,
            temporalRunId: runId,
            temporalStartedAt,
          },
        });

        (goalRun as any).temporalWorkflowId = workflowId;
        (goalRun as any).temporalRunId = runId;
        (goalRun as any).temporalStartedAt = temporalStartedAt;

        // Note: Do NOT set workflowRunId here. That field references the legacy
        // workflow_runs table (FK constraint), but Temporal workflows don't create
        // WorkflowRun records. The Temporal workflow can be queried by workflowId
        // which contains the goalRunId (format: goal-run-{goalRunId}).
        // Phase 9.2b fix: Removed workflowRunId update that caused FK violation.

        await this.createActivityEvent(goalRunId, {
          eventType: 'TEMPORAL_WORKFLOW_STARTED',
          title: 'Temporal workflow started',
          description: `Workflow ID: ${workflowId}`,
          details: { workflowId, runId },
        });
      } catch (error: any) {
        this.logger.error(`Failed to start Temporal workflow for ${goalRunId}: ${error.message}`);
        // Do not silently change engines; make the failure explicit and fail closed.
        await this.createActivityEvent(goalRunId, {
          eventType: 'TEMPORAL_WORKFLOW_START_FAILED',
          title: 'Temporal workflow failed to start',
          description: error.message,
          severity: 'error',
        });

        const failed = await this.prisma.goalRun.update({
          where: { id: goalRunId },
          data: {
            status: GoalRunStatus.FAILED,
            phase: GoalRunPhase.FAILED,
            error: `Temporal workflow start failed: ${error.message}`,
          },
        });

        return this.toGoalRunResponse(failed);
      }
      }
    }

    // Emit start event to trigger orchestrator loop (legacy path or fallback)
    if (executionEngine === GoalRunExecutionEngine.LEGACY_DB_LOOP) {
      this.eventEmitter.emit('goal-run.started', { goalRunId });
    }

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_STARTED',
      title: 'Goal run started',
      description:
        executionEngine === GoalRunExecutionEngine.TEMPORAL_WORKFLOW
          ? 'Temporal workflow initiated'
          : 'Orchestrator loop initiated',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Update goal run phase
   */
  async updatePhase(goalRunId: string, phase: GoalRunPhase): Promise<GoalRunResponse> {
    this.logger.log(`Updating goal run ${goalRunId} phase to ${phase}`);

    const previousGoalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { phase },
    });

    // Emit phase change event
    this.eventEmitter.emit('goal-run.phase-changed', {
      goalRunId,
      previousPhase: previousGoalRun?.phase,
      newPhase: phase,
    });

    await this.createActivityEvent(goalRunId, {
      eventType: 'PHASE_CHANGED',
      title: `Phase changed to ${phase}`,
      description: `Previous phase: ${previousGoalRun?.phase}`,
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Update goal run status
   */
  async updateStatus(goalRunId: string, status: GoalRunStatus): Promise<GoalRunResponse> {
    this.logger.log(`Updating goal run ${goalRunId} status to ${status}`);

    const data: Prisma.GoalRunUpdateInput = { status };

    if (status === GoalRunStatus.COMPLETED || status === GoalRunStatus.FAILED) {
      data.completedAt = new Date();
      data.phase =
        status === GoalRunStatus.COMPLETED ? GoalRunPhase.COMPLETED : GoalRunPhase.FAILED;
    }

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data,
    });

    this.eventEmitter.emit('goal-run.status-changed', {
      goalRunId,
      status,
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Link a workflow run to this goal run
   */
  async linkWorkflowRun(goalRunId: string, workflowRunId: string): Promise<GoalRunResponse> {
    this.logger.log(`Linking workflow run ${workflowRunId} to goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { workflowRunId },
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Pause goal run
   * v1.1.0: Added Temporal workflow signal support
   */
  async pauseGoalRun(goalRunId: string): Promise<GoalRunResponse> {
    this.logger.log(`Pausing goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { phase: GoalRunPhase.PAUSED },
    });

    // Send pause signal to Temporal workflow if active
    if (goalRun.workflowRunId && this.temporalWorkflowService?.isEnabled()) {
      try {
        await this.temporalWorkflowService.pauseWorkflow(goalRunId);
        this.logger.log(`Sent pause signal to Temporal workflow for ${goalRunId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send pause signal to Temporal: ${error.message}`);
      }
    }

    this.eventEmitter.emit('goal-run.paused', { goalRunId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_PAUSED',
      title: 'Goal run paused',
      severity: 'warning',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Resume goal run
   * v1.1.0: Added Temporal workflow signal support
   */
  async resumeGoalRun(goalRunId: string): Promise<GoalRunResponse> {
    this.logger.log(`Resuming goal run ${goalRunId}`);

    // Get current state to determine resume phase
    const currentGoalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
      include: {
        planVersions: {
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });

    if (!currentGoalRun) {
      throw new NotFoundException(`Goal run ${goalRunId} not found`);
    }

    // Resume to EXECUTING if we have a plan, otherwise PLANNING
    const resumePhase = currentGoalRun.planVersions.length > 0
      ? GoalRunPhase.EXECUTING
      : GoalRunPhase.PLANNING;

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { phase: resumePhase },
    });

    // Send resume signal to Temporal workflow if active
    if (goalRun.workflowRunId && this.temporalWorkflowService?.isEnabled()) {
      try {
        await this.temporalWorkflowService.resumeWorkflow(goalRunId);
        this.logger.log(`Sent resume signal to Temporal workflow for ${goalRunId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send resume signal to Temporal: ${error.message}`);
      }
    }

    this.eventEmitter.emit('goal-run.resumed', { goalRunId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_RESUMED',
      title: 'Goal run resumed',
      description: `Resuming in ${resumePhase} phase`,
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Cancel goal run
   * v1.1.0: Added Temporal workflow signal support
   */
  async cancelGoalRun(goalRunId: string, reason?: string): Promise<GoalRunResponse> {
    this.logger.log(`Cancelling goal run ${goalRunId}: ${reason}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: GoalRunStatus.CANCELLED,
        phase: GoalRunPhase.FAILED,
        error: reason || 'Cancelled by user',
        completedAt: new Date(),
      },
    });

    // Cancel Temporal workflow if active (preferred path)
    if (goalRun.workflowRunId && this.temporalWorkflowService?.isEnabled()) {
      try {
        await this.temporalWorkflowService.cancelWorkflow(goalRunId, reason || 'Cancelled by user');
        this.logger.log(`Sent cancel signal to Temporal workflow for ${goalRunId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send cancel signal to Temporal: ${error.message}`);
        // Try legacy workflow cancellation as fallback
        try {
          await this.workflowService.cancelWorkflow(goalRun.workflowRunId, reason);
        } catch (legacyError: any) {
          this.logger.warn(`Failed to cancel legacy workflow: ${legacyError.message}`);
        }
      }
    } else if (goalRun.workflowRunId) {
      // Legacy workflow cancellation
      try {
        await this.workflowService.cancelWorkflow(goalRun.workflowRunId, reason);
      } catch (error: any) {
        this.logger.warn(`Failed to cancel linked workflow: ${error.message}`);
      }
    }

    this.eventEmitter.emit('goal-run.cancelled', { goalRunId, reason });

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_CANCELLED',
      title: 'Goal run cancelled',
      description: reason,
      severity: 'warning',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Complete goal run successfully
   */
  async completeGoalRun(goalRunId: string): Promise<GoalRunResponse> {
    this.logger.log(`Completing goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: GoalRunStatus.COMPLETED,
        phase: GoalRunPhase.COMPLETED,
        completedAt: new Date(),
      },
    });

    this.eventEmitter.emit('goal-run.completed', { goalRunId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_COMPLETED',
      title: 'Goal completed successfully',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Fail goal run
   */
  async failGoalRun(goalRunId: string, error: string): Promise<GoalRunResponse> {
    this.logger.log(`Failing goal run ${goalRunId}: ${error}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        status: GoalRunStatus.FAILED,
        phase: GoalRunPhase.FAILED,
        error,
        completedAt: new Date(),
      },
    });

    this.eventEmitter.emit('goal-run.failed', { goalRunId, error });

    await this.createActivityEvent(goalRunId, {
      eventType: 'GOAL_FAILED',
      title: 'Goal run failed',
      description: error,
      severity: 'error',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Get current plan for a goal run
   */
  async getCurrentPlan(goalRunId: string): Promise<PlanVersionResponse | null> {
    const planVersion = await this.prisma.planVersion.findFirst({
      where: { goalRunId },
      orderBy: { version: 'desc' },
      include: {
        checklistItems: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!planVersion) {
      return null;
    }

    return {
      id: planVersion.id,
      version: planVersion.version,
      summary: planVersion.summary,
      replanReason: planVersion.replanReason,
      confidence: planVersion.confidence,
      createdAt: planVersion.createdAt,
      items: planVersion.checklistItems.map(this.toChecklistItemResponse),
    };
  }

  /**
   * Get plan history for a goal run
   */
  async getPlanHistory(goalRunId: string): Promise<PlanVersionResponse[]> {
    const planVersions = await this.prisma.planVersion.findMany({
      where: { goalRunId },
      orderBy: { version: 'desc' },
      include: {
        checklistItems: {
          orderBy: { order: 'asc' },
        },
      },
    });

    return planVersions.map((pv) => ({
      id: pv.id,
      version: pv.version,
      summary: pv.summary,
      replanReason: pv.replanReason,
      confidence: pv.confidence,
      createdAt: pv.createdAt,
      items: pv.checklistItems.map(this.toChecklistItemResponse),
    }));
  }

  /**
   * Submit steering message
   * v1.1.0: Added Temporal workflow signal support for steering
   */
  async submitSteering(goalRunId: string, input: SteeringInput): Promise<void> {
    this.logger.log(`Steering message for goal run ${goalRunId}: ${input.type}`);

    // Get goal run to check if Temporal workflow is active
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    const hasTemporalWorkflow = goalRun?.workflowRunId && this.temporalWorkflowService?.isEnabled();

    await this.prisma.steeringMessage.create({
      data: {
        goalRunId,
        type: input.type,
        content: input.content,
        targetItemId: input.targetItemId,
        userId: input.userId,
        userEmail: input.userEmail,
      },
    });

    // Handle immediate actions
    switch (input.type) {
      case 'PAUSE':
        await this.pauseGoalRun(goalRunId);
        break;
      case 'RESUME':
        await this.resumeGoalRun(goalRunId);
        break;
      case 'CANCEL':
        await this.cancelGoalRun(goalRunId, input.content);
        break;
      case 'APPROVE':
        // Send approve signal to Temporal if active
        if (hasTemporalWorkflow && input.targetItemId) {
          try {
            await this.temporalWorkflowService!.approveStep(
              goalRunId,
              input.targetItemId,
              input.userId || input.userEmail || 'unknown',
            );
            this.logger.log(`Sent approve signal to Temporal for step ${input.targetItemId}`);
          } catch (error: any) {
            this.logger.warn(`Failed to send approve signal to Temporal: ${error.message}`);
          }
        }
        break;
      case 'REJECT':
        // Send reject signal to Temporal if active
        if (hasTemporalWorkflow && input.targetItemId) {
          try {
            await this.temporalWorkflowService!.rejectStep(
              goalRunId,
              input.targetItemId,
              input.content || 'No reason provided',
              input.userId || input.userEmail,
            );
            this.logger.log(`Sent reject signal to Temporal for step ${input.targetItemId}`);
          } catch (error: any) {
            this.logger.warn(`Failed to send reject signal to Temporal: ${error.message}`);
          }
        }
        break;
      case 'INSTRUCTION':
        // Send steering instruction to Temporal workflow
        if (hasTemporalWorkflow && input.content) {
          try {
            await this.temporalWorkflowService!.sendSteeringInstruction(
              goalRunId,
              input.content,
              'NORMAL',
            );
            this.logger.log(`Sent steering instruction to Temporal for ${goalRunId}`);
          } catch (error: any) {
            this.logger.warn(`Failed to send steering instruction to Temporal: ${error.message}`);
          }
        }
        // Fall through to emit event for legacy orchestrator
        this.eventEmitter.emit('goal-run.steering-received', {
          goalRunId,
          type: input.type,
          content: input.content,
        });
        break;
      default:
        // Other steering types handled by orchestrator loop
        this.eventEmitter.emit('goal-run.steering-received', {
          goalRunId,
          type: input.type,
          content: input.content,
        });
    }

    await this.createActivityEvent(goalRunId, {
      eventType: 'STEERING_RECEIVED',
      title: `Steering: ${input.type}`,
      description: input.content,
    });
  }

  /**
   * Get pending steering messages
   */
  async getPendingSteering(goalRunId: string): Promise<any | null> {
    return this.prisma.steeringMessage.findFirst({
      where: {
        goalRunId,
        acknowledged: false,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Acknowledge steering message
   */
  async acknowledgeSteering(steeringId: string): Promise<void> {
    await this.prisma.steeringMessage.update({
      where: { id: steeringId },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
      },
    });
  }

  /**
   * Create activity event
   */
  async createActivityEvent(
    goalRunId: string,
    event: {
      eventType: string;
      title: string;
      description?: string;
      severity?: string;
      details?: Record<string, any>;
      planVersionId?: string;
      checklistItemId?: string;
      workflowNodeId?: string;
    },
  ): Promise<void> {
    await this.prisma.activityEvent.create({
      data: {
        goalRunId,
        eventType: event.eventType,
        title: event.title,
        description: event.description,
        severity: event.severity || 'info',
        details: event.details || {},
        planVersionId: event.planVersionId,
        checklistItemId: event.checklistItemId,
        workflowNodeId: event.workflowNodeId,
      },
    });

    // Emit for real-time delivery
    this.eventEmitter.emit('activity-event.created', {
      goalRunId,
      ...event,
    });
  }

  /**
   * Get activity feed for a goal run
   */
  async getActivityFeed(
    goalRunId: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<PaginatedResponse<any>> {
    const page = options?.page || 1;
    const pageSize = options?.pageSize || 50;
    const skip = (page - 1) * pageSize;

    const [events, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where: { goalRunId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.activityEvent.count({ where: { goalRunId } }),
    ]);

    return {
      data: events,
      total,
      page,
      pageSize,
      hasMore: skip + events.length < total,
    };
  }

  /**
   * User intervention - take control from agent (Phase 4)
   */
  async intervene(goalRunId: string, userId?: string): Promise<GoalRunResponse> {
    this.logger.log(`User intervention on goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        phase: GoalRunPhase.CONTROLLING_DESKTOP,
      },
    });

    this.eventEmitter.emit('goal-run.intervened', { goalRunId, userId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'USER_INTERVENED',
      title: 'User took control',
      description: 'Agent paused, user controlling desktop',
      severity: 'warning',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Return control to agent after intervention (Phase 4)
   */
  async returnControl(goalRunId: string, userId?: string): Promise<GoalRunResponse> {
    this.logger.log(`Returning control to agent for goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: {
        phase: GoalRunPhase.EXECUTING,
      },
    });

    this.eventEmitter.emit('goal-run.control-returned', { goalRunId, userId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'CONTROL_RETURNED',
      title: 'Control returned to agent',
      description: 'Resuming autonomous execution',
    });

    return this.toGoalRunResponse(goalRun);
  }

  /**
   * Approve a step (Phase 4)
   * v1.1.0: Added Temporal workflow signal support
   */
  async approveStep(goalRunId: string, stepId: string, userId?: string): Promise<ChecklistItemResponse> {
    this.logger.log(`Approving step ${stepId} for goal run ${goalRunId}`);

    const item = await this.prisma.checklistItem.update({
      where: { id: stepId },
      data: {
        status: ChecklistItemStatus.COMPLETED,
        actualOutcome: 'Approved by user',
        completedAt: new Date(),
      },
    });

    // Update goal run phase if it was waiting for approval
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    if (goalRun?.phase === GoalRunPhase.WAITING_APPROVAL) {
      await this.prisma.goalRun.update({
        where: { id: goalRunId },
        data: { phase: GoalRunPhase.EXECUTING },
      });
    }

    // Send approve signal to Temporal workflow if active
    if (goalRun?.workflowRunId && this.temporalWorkflowService?.isEnabled()) {
      try {
        await this.temporalWorkflowService.approveStep(goalRunId, stepId, userId || 'unknown');
        this.logger.log(`Sent approve signal to Temporal for step ${stepId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send approve signal to Temporal: ${error.message}`);
      }
    }

    this.eventEmitter.emit('step.approved', { goalRunId, stepId, userId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'STEP_APPROVED',
      title: 'Step approved',
      description: item.description,
      checklistItemId: stepId,
    });

    return this.toChecklistItemResponse(item);
  }

  /**
   * Reject a step (Phase 4)
   * v1.1.0: Added Temporal workflow signal support
   */
  async rejectStep(goalRunId: string, stepId: string, reason: string, userId?: string): Promise<ChecklistItemResponse> {
    this.logger.log(`Rejecting step ${stepId} for goal run ${goalRunId}: ${reason}`);

    const item = await this.prisma.checklistItem.update({
      where: { id: stepId },
      data: {
        status: ChecklistItemStatus.FAILED,
        actualOutcome: `Rejected: ${reason}`,
        completedAt: new Date(),
      },
    });

    // Get goal run for Temporal check
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    // Trigger replan
    await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { phase: GoalRunPhase.REPLANNING },
    });

    // Send reject signal to Temporal workflow if active
    if (goalRun?.workflowRunId && this.temporalWorkflowService?.isEnabled()) {
      try {
        await this.temporalWorkflowService.rejectStep(goalRunId, stepId, reason, userId);
        this.logger.log(`Sent reject signal to Temporal for step ${stepId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send reject signal to Temporal: ${error.message}`);
      }
    }

    this.eventEmitter.emit('step.rejected', { goalRunId, stepId, reason, userId });

    await this.createActivityEvent(goalRunId, {
      eventType: 'STEP_REJECTED',
      title: 'Step rejected',
      description: `${item.description}: ${reason}`,
      severity: 'warning',
      checklistItemId: stepId,
    });

    return this.toChecklistItemResponse(item);
  }

  /**
   * Get goal run metrics
   */
  async getMetrics(goalRunId: string): Promise<{
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    replanCount: number;
    durationMs?: number;
  }> {
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
      include: {
        planVersions: {
          include: {
            checklistItems: true,
          },
        },
      },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${goalRunId} not found`);
    }

    const currentPlan = goalRun.planVersions.sort((a, b) => b.version - a.version)[0];
    const items = currentPlan?.checklistItems || [];

    const completedSteps = items.filter(
      (item) => item.status === ChecklistItemStatus.COMPLETED,
    ).length;
    const failedSteps = items.filter(
      (item) => item.status === ChecklistItemStatus.FAILED,
    ).length;

    const durationMs =
      goalRun.startedAt && goalRun.completedAt
        ? goalRun.completedAt.getTime() - goalRun.startedAt.getTime()
        : goalRun.startedAt
        ? Date.now() - goalRun.startedAt.getTime()
        : undefined;

    return {
      totalSteps: items.length,
      completedSteps,
      failedSteps,
      replanCount: goalRun.planVersions.length - 1,
      durationMs,
    };
  }

  // Helper methods

  private toGoalRunResponse(goalRun: any): GoalRunResponse {
    return {
      id: goalRun.id,
      tenantId: goalRun.tenantId,
      goal: goalRun.goal,
      constraints: goalRun.constraints as GoalConstraints,
      phase: goalRun.phase,
      status: goalRun.status,
      executionEngine:
        goalRun.executionEngine ?? GoalRunExecutionEngine.LEGACY_DB_LOOP,
      workflowRunId: goalRun.workflowRunId,
      temporalWorkflowId: goalRun.temporalWorkflowId ?? null,
      temporalRunId: goalRun.temporalRunId ?? null,
      temporalStartedAt: goalRun.temporalStartedAt ?? null,
      currentPlanVersion: goalRun.currentPlanVersion,
      error: goalRun.error,
      createdAt: goalRun.createdAt,
      updatedAt: goalRun.updatedAt,
      startedAt: goalRun.startedAt,
      completedAt: goalRun.completedAt,
    };
  }

  private toChecklistItemResponse(item: any): ChecklistItemResponse {
    const type: StepType = item.type ?? StepType.EXECUTE;
    const suggestedTools: string[] = Array.isArray(item.suggestedTools) ? item.suggestedTools : [];
    const isExternalInput = type === StepType.USER_INPUT_REQUIRED || hasUserInteractionTool(suggestedTools);
    const isLegacyPromptStep = type !== StepType.USER_INPUT_REQUIRED && hasUserInteractionTool(suggestedTools);

    return {
      id: item.id,
      order: item.order,
      description: item.description,
      status: item.status,
      type,
      suggestedTools,
      requiresDesktop: item.requiresDesktop ?? false,
      executionSurface:
        item.executionSurface ?? ((item.requiresDesktop ?? false) ? ExecutionSurface.DESKTOP : ExecutionSurface.TEXT_ONLY),
      isExternalInput,
      isLegacyPromptStep,
      expectedOutcome: item.expectedOutcome,
      actualOutcome: item.actualOutcome,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
    };
  }
}
