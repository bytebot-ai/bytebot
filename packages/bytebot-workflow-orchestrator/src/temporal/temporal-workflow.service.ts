/**
 * Temporal Workflow Service
 *
 * Provides methods to start, signal, query, and manage Temporal workflows.
 * This service wraps the Temporal Client for use by GoalsService.
 *
 * Key features:
 * - Start GoalRunWorkflow with input validation
 * - Send signals (pause, resume, cancel, approve, reject, steer)
 * - Query workflow state (progress, checkpoint, current step)
 * - Get workflow handle for existing workflows
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, WorkflowHandle, WorkflowNotFoundError } from '@temporalio/client';
import { TEMPORAL_CLIENT } from './constants';

// Import workflow types from temporal worker package
// These types define the workflow interface
interface GoalRunInput {
  goalRunId: string;
  tenantId: string;
  userId: string;
  goalDescription: string;
  workspaceId?: string;
  constraints?: {
    maxSteps?: number;
    maxRetries?: number;
    maxReplans?: number;
    timeoutMs?: number;
    requireApprovalForHighRisk?: boolean;
  };
  context?: {
    previousAttempts?: number;
    parentGoalRunId?: string;
    inheritedKnowledge?: string[];
  };
}

interface GoalRunResult {
  goalRunId: string;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';
  completedAt: string;
  summary: string;
  stepsCompleted: number;
  totalDurationMs: number;
  finalOutcome?: string;
  errorDetails?: {
    errorType: string;
    errorMessage: string;
    failedStep?: number;
    recoverable: boolean;
  };
  artifacts: Array<{ type: string; path: string; description?: string }>;
  knowledgeGained: string[];
}

interface GoalProgress {
  goalRunId: string;
  phase: string;
  currentStep: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  percentComplete: number;
  startedAt: string;
  lastUpdatedAt: string;
  isPaused: boolean;
  isAwaitingApproval: boolean;
}

interface GoalCheckpoint {
  goalRunId: string;
  version: number;
  checkpointedAt: string;
  phase: string;
  progressSummary: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    percentComplete: number;
  };
  completedWork: Array<{
    stepNumber: number;
    description: string;
    outcome: string;
    completedAt: string;
  }>;
  currentContext: {
    lastSuccessfulStep?: string;
    currentStep?: string;
    failureReason?: string;
    accumulatedKnowledge: string[];
  };
  remainingSteps: Array<{
    stepNumber: number;
    description: string;
  }>;
}

@Injectable()
export class TemporalWorkflowService {
  private readonly logger = new Logger(TemporalWorkflowService.name);
  private readonly taskQueue: string;
  private readonly workflowIdPrefix = 'goal-run';

  constructor(
    @Optional() @Inject(TEMPORAL_CLIENT) private readonly client: Client | null,
    private readonly configService: ConfigService,
  ) {
    this.taskQueue = this.configService.get<string>('TEMPORAL_TASK_QUEUE', 'bytebot-goal-runs');
  }

  /**
   * Check if Temporal is enabled and available
   */
  isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * Get workflow ID for a goal run
   */
  getWorkflowId(goalRunId: string): string {
    return `${this.workflowIdPrefix}-${goalRunId}`;
  }

  /**
   * Start a new GoalRunWorkflow
   */
  async startGoalRunWorkflow(input: GoalRunInput): Promise<{
    workflowId: string;
    runId: string;
  }> {
    if (!this.client) {
      throw new Error('Temporal client not available');
    }

    const workflowId = this.getWorkflowId(input.goalRunId);

    this.logger.log(`Starting workflow ${workflowId} for goal run ${input.goalRunId}`);

    try {
      const handle = await this.client.workflow.start('goalRunWorkflow', {
        taskQueue: this.taskQueue,
        workflowId,
        args: [input],
        // Workflow-level timeout (1 hour default, can be overridden)
        workflowExecutionTimeout: input.constraints?.timeoutMs
          ? `${input.constraints.timeoutMs}ms`
          : '1h',
      });

      this.logger.log(`Workflow ${workflowId} started with run ID ${handle.workflowId}`);

      return {
        workflowId: handle.workflowId,
        runId: handle.firstExecutionRunId,
      };
    } catch (error) {
      this.logger.error(`Failed to start workflow ${workflowId}:`, error);
      throw error;
    }
  }

  /**
   * Get handle to an existing workflow
   */
  async getWorkflowHandle(goalRunId: string): Promise<WorkflowHandle | null> {
    if (!this.client) {
      return null;
    }

    const workflowId = this.getWorkflowId(goalRunId);

    try {
      return this.client.workflow.getHandle(workflowId);
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Send pause signal to workflow
   */
  async pauseWorkflow(goalRunId: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending pause signal to workflow for goal run ${goalRunId}`);
    await handle.signal('pauseGoal');
  }

  /**
   * Send resume signal to workflow
   */
  async resumeWorkflow(goalRunId: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending resume signal to workflow for goal run ${goalRunId}`);
    await handle.signal('resumeGoal');
  }

  /**
   * Send cancel signal to workflow
   */
  async cancelWorkflow(goalRunId: string, reason: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending cancel signal to workflow for goal run ${goalRunId}: ${reason}`);
    await handle.signal('cancelGoal', { reason });
  }

  /**
   * Send approve step signal to workflow
   */
  async approveStep(goalRunId: string, stepId: string, approver: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending approve signal for step ${stepId} in goal run ${goalRunId}`);
    await handle.signal('approveStep', {
      stepId,
      approver,
      approvedAt: new Date().toISOString(),
    });
  }

  /**
   * Resume a workflow from an external input request (prompt) using a Temporal Update.
   *
   * Prefer Updates over Signals for this path because Updates provide synchronous confirmation and
   * an UpdateId can be used as an idempotency key (replay-safe under retries).
   */
  async resumeFromUserPrompt(
    goalRunId: string,
    payload: { promptId: string; answers: Record<string, any> },
    options?: { updateId?: string },
  ): Promise<{ didResume: boolean }> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      return { didResume: false };
    }

    await handle.executeUpdate('userPromptResolved', {
      args: [payload],
      updateId: options?.updateId,
    });

    return { didResume: true };
  }

  /**
   * Send reject step signal to workflow
   */
  async rejectStep(goalRunId: string, stepId: string, reason: string, rejector?: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending reject signal for step ${stepId} in goal run ${goalRunId}: ${reason}`);
    await handle.signal('rejectStep', {
      stepId,
      reason,
      rejector,
      rejectedAt: new Date().toISOString(),
    });
  }

  /**
   * Send steering instruction to workflow
   */
  async sendSteeringInstruction(
    goalRunId: string,
    instruction: string,
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' = 'NORMAL',
  ): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.log(`Sending steering instruction to goal run ${goalRunId}: ${instruction}`);
    await handle.signal('steer', {
      instruction,
      priority,
      addToContext: true,
    });
  }

  /**
   * Query workflow progress
   */
  async getProgress(goalRunId: string): Promise<GoalProgress | null> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      return null;
    }

    try {
      return await handle.query<GoalProgress>('getProgress');
    } catch (error) {
      this.logger.warn(`Failed to query progress for ${goalRunId}:`, error);
      return null;
    }
  }

  /**
   * Query workflow checkpoint
   */
  async getCheckpoint(goalRunId: string): Promise<GoalCheckpoint | null> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      return null;
    }

    try {
      return await handle.query<GoalCheckpoint>('getCheckpoint');
    } catch (error) {
      this.logger.warn(`Failed to query checkpoint for ${goalRunId}:`, error);
      return null;
    }
  }

  /**
   * Wait for workflow result (blocking)
   */
  async waitForResult(goalRunId: string): Promise<GoalRunResult | null> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      return null;
    }

    try {
      return await handle.result();
    } catch (error) {
      this.logger.error(`Workflow ${goalRunId} failed:`, error);
      throw error;
    }
  }

  /**
   * Check if workflow exists and is running
   */
  async isWorkflowRunning(goalRunId: string): Promise<boolean> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      return false;
    }

    try {
      const describe = await handle.describe();
      return describe.status.name === 'RUNNING';
    } catch (error) {
      return false;
    }
  }

  /**
   * Terminate workflow (force stop)
   */
  async terminateWorkflow(goalRunId: string, reason: string): Promise<void> {
    const handle = await this.getWorkflowHandle(goalRunId);
    if (!handle) {
      throw new Error(`Workflow not found for goal run ${goalRunId}`);
    }

    this.logger.warn(`Terminating workflow for goal run ${goalRunId}: ${reason}`);
    await handle.terminate(reason);
  }
}
