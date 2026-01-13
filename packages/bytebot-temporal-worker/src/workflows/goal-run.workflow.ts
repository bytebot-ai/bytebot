/**
 * GoalRunWorkflow - Durable Workflow for ByteBot Goal Execution
 *
 * Industry-standard patterns:
 * - OpenAI: Exponential backoff, background execution
 * - Anthropic: Git-style checkpointing, context engineering
 * - Manus AI: "Leave wrong turns in context", todo.md persistence
 * - Google SRE: Failure classification, retry budgets
 *
 * Key Features:
 * - Durable PEVR cycle (Plan → Execute → Verify → Replan)
 * - Automatic retries with exponential backoff
 * - Signal-based human-in-the-loop (approve, reject, steer)
 * - Query-based progress inspection
 * - Kafka event emission for observability
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  defineUpdate,
  setHandler,
  condition,
  sleep,
  workflowInfo,
  patched,
  CancellationScope,
  isCancellation,
  ApplicationFailure,
  upsertSearchAttributes,
} from '@temporalio/workflow';

// Phase 10.2: Import search attribute configuration
import {
  SEARCH_ATTRIBUTES,
  createPhaseUpdate,
  createPlanSearchAttributes,
  createApprovalStateUpdate,
  createErrorSearchAttributes,
} from '../config/search-attributes.config';

// Phase 10.5: Import workflow versioning
import { WORKFLOW_PATCHES, WORKFLOW_VERSION } from '../config/workflow-versions';

import type { PlanningActivities } from '../activities/planning.activities';
import type { ExecutionActivities } from '../activities/execution.activities';
import type { KafkaActivities } from '../activities/kafka.activities';

import type {
  GoalRunInput,
  GoalRunResult,
  GoalProgress,
  GoalCheckpoint,
  Step,
  StepResult,
  ApproveStepPayload,
  RejectStepPayload,
  CancelGoalPayload,
  SteerPayload,
  GoalRunPhase,
} from '../types/goal-run.types';

// ============================================================================
// Activity Proxies with Retry Policies
// ============================================================================

const planningActivities = proxyActivities<PlanningActivities>({
  startToCloseTimeout: '5m',
  retry: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
  },
});

const executionActivities = proxyActivities<ExecutionActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '30s', // Activity must heartbeat every 30s
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 3,
  },
});

const kafkaActivities = proxyActivities<KafkaActivities>({
  startToCloseTimeout: '10s',
  retry: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '5s',
    maximumAttempts: 3,
  },
});

// ============================================================================
// Signal Definitions
// ============================================================================

export const approveStepSignal = defineSignal<[ApproveStepPayload]>('approveStep');
export const rejectStepSignal = defineSignal<[RejectStepPayload]>('rejectStep');
export const pauseGoalSignal = defineSignal('pauseGoal');
export const resumeGoalSignal = defineSignal('resumeGoal');
export const cancelGoalSignal = defineSignal<[CancelGoalPayload]>('cancelGoal');
export const steerSignal = defineSignal<[SteerPayload]>('steer');
export const userPromptResolvedSignal = defineSignal<[UserPromptResolvedPayload]>('userPromptResolved');

export interface UserPromptResolvedPayload {
  promptId: string;
  answers: Record<string, any>;
}

// ============================================================================
// Query Definitions
// ============================================================================

export const getProgressQuery = defineQuery<GoalProgress>('getProgress');
export const getCurrentStepQuery = defineQuery<Step | null>('getCurrentStep');
export const getCheckpointQuery = defineQuery<GoalCheckpoint>('getCheckpoint');
export const getStepResultsQuery = defineQuery<StepResult[]>('getStepResults');

// ============================================================================
// Update Definitions - Phase 10.3: Synchronous Operations
// ============================================================================

/**
 * Add context/knowledge to the workflow.
 * Returns the updated list of accumulated knowledge.
 * Unlike signals, updates provide synchronous confirmation.
 */
export interface AddKnowledgePayload {
  knowledge: string[];
  source?: string;
}
export const addKnowledgeUpdate = defineUpdate<string[], [AddKnowledgePayload]>('addKnowledge');

/**
 * Modify step priority/order during execution.
 * Returns true if modification was accepted.
 */
export interface ModifyStepsPayload {
  skipSteps?: number[];      // Step numbers to skip
  prioritizeStep?: number;   // Move this step to next
  addSteps?: Array<{ description: string; insertAfter: number }>;
}
export interface ModifyStepsResult {
  accepted: boolean;
  message: string;
  newStepOrder?: number[];
}
export const modifyStepsUpdate = defineUpdate<ModifyStepsResult, [ModifyStepsPayload]>('modifySteps');

/**
 * Force immediate checkpoint/snapshot of workflow state.
 * Returns the checkpoint data synchronously.
 */
export const forceCheckpointUpdate = defineUpdate<GoalCheckpoint>('forceCheckpoint');

/**
 * Request workflow to pause at next safe point.
 * Returns current phase and expected pause point.
 */
export interface PauseRequestResult {
  willPauseAt: string;
  currentPhase: GoalRunPhase;
  acknowledgment: string;
}
export const requestPauseUpdate = defineUpdate<PauseRequestResult>('requestPause');

/**
 * Stark Fix: Resume from an External Input Request (prompt) with synchronous confirmation.
 * The orchestrator uses this Update (with a stable updateId) to achieve replay-safe, idempotent resume.
 */
export interface UserPromptResolvedResult {
  accepted: boolean;
  applied: boolean;
  promptId?: string;
  message?: string;
}
export const userPromptResolvedUpdate =
  defineUpdate<UserPromptResolvedResult, [UserPromptResolvedPayload]>('userPromptResolved');

// ============================================================================
// Workflow State (Durable - survives crashes)
// ============================================================================

interface WorkflowState {
  phase: GoalRunPhase;
  steps: Step[];
  stepResults: StepResult[];
  currentStepIndex: number;
  isPaused: boolean;
  isCancelled: boolean;
  cancelReason: string | null;
  isAwaitingApproval: boolean;
  approvalStepId: string | null;
  approvalResult: 'APPROVED' | 'REJECTED' | null;
  rejectionReason: string | null;
  isWaitingUserInput: boolean;
  waitingUserInputForStep: number | null;
  waitingUserInputReason: 'GOAL_INTAKE' | 'STEP_INPUT' | null;
  lastUserPromptId: string | null;
  pendingUserPrompts: Array<{ promptId: string; answers: Record<string, any> }>;
  accumulatedKnowledge: string[];
  failureHistory: Array<{ stepNumber: number; error: string }>;
  replanCount: number;
  startedAt: string;
  lastUpdatedAt: string;
  steeringInstructions: SteerPayload[];
}

// ============================================================================
// Main Workflow
// ============================================================================

export async function goalRunWorkflow(input: GoalRunInput): Promise<GoalRunResult> {
  const { workflowId, runId } = workflowInfo();
  const constraints = input.constraints ?? {
    maxSteps: 50,
    maxRetries: 3,
    maxReplans: 3,
    timeoutMs: 3600000,
    requireApprovalForHighRisk: true,
  };

  // Initialize workflow state
  const state: WorkflowState = {
    phase: 'INITIALIZING' as GoalRunPhase,
    steps: [],
    stepResults: [],
    currentStepIndex: 0,
    isPaused: false,
    isCancelled: false,
    cancelReason: null,
    isAwaitingApproval: false,
    approvalStepId: null,
    approvalResult: null,
    rejectionReason: null,
    isWaitingUserInput: false,
    waitingUserInputForStep: null,
    waitingUserInputReason: null,
    lastUserPromptId: null,
    pendingUserPrompts: [],
    accumulatedKnowledge: input.context?.inheritedKnowledge ?? [],
    failureHistory: [],
    replanCount: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    steeringInstructions: [],
  };

  // ============================================================================
  // Signal Handlers
  // ============================================================================

  setHandler(approveStepSignal, (payload: ApproveStepPayload) => {
    if (state.isAwaitingApproval && state.approvalStepId === payload.stepId) {
      state.approvalResult = 'APPROVED';
      state.isAwaitingApproval = false;
      state.lastUpdatedAt = new Date().toISOString();
    }
  });

  setHandler(rejectStepSignal, (payload: RejectStepPayload) => {
    if (state.isAwaitingApproval && state.approvalStepId === payload.stepId) {
      state.approvalResult = 'REJECTED';
      state.rejectionReason = payload.reason;
      state.isAwaitingApproval = false;
      state.lastUpdatedAt = new Date().toISOString();
    }
  });

  setHandler(pauseGoalSignal, () => {
    state.isPaused = true;
    state.lastUpdatedAt = new Date().toISOString();
  });

  setHandler(resumeGoalSignal, () => {
    state.isPaused = false;
    state.lastUpdatedAt = new Date().toISOString();
  });

  setHandler(cancelGoalSignal, (payload: CancelGoalPayload) => {
    state.isCancelled = true;
    state.cancelReason = payload.reason;
    state.phase = 'CANCELLED' as GoalRunPhase;
    state.lastUpdatedAt = new Date().toISOString();
  });

  setHandler(steerSignal, (payload: SteerPayload) => {
    state.steeringInstructions.push(payload);
    if (payload.addToContext) {
      state.accumulatedKnowledge.push(`[STEERING] ${payload.instruction}`);
    }
    state.lastUpdatedAt = new Date().toISOString();
  });

  setHandler(userPromptResolvedSignal, (payload: UserPromptResolvedPayload) => {
    if (payload.promptId && payload.promptId === state.lastUserPromptId) {
      return;
    }

    state.lastUserPromptId = payload.promptId;
    state.pendingUserPrompts.push({ promptId: payload.promptId, answers: payload.answers });
    state.lastUpdatedAt = new Date().toISOString();
  });

  // ============================================================================
  // Query Handlers
  // ============================================================================

  setHandler(getProgressQuery, (): GoalProgress => ({
    goalRunId: input.goalRunId,
    phase: state.phase,
    currentStep: state.currentStepIndex,
    totalSteps: state.steps.length,
    completedSteps: state.stepResults.filter((r) => r.status === 'COMPLETED').length,
    failedSteps: state.stepResults.filter((r) => r.status === 'FAILED').length,
    percentComplete: state.steps.length > 0
      ? Math.round((state.stepResults.filter((r) => r.status === 'COMPLETED').length / state.steps.length) * 100)
      : 0,
    startedAt: state.startedAt,
    lastUpdatedAt: state.lastUpdatedAt,
    isPaused: state.isPaused,
    isAwaitingApproval: state.isAwaitingApproval,
    isWaitingUserInput: state.isWaitingUserInput || state.phase === ('WAITING_USER_INPUT' as GoalRunPhase),
  }));

  setHandler(getCurrentStepQuery, (): Step | null => {
    if (state.currentStepIndex >= 0 && state.currentStepIndex < state.steps.length) {
      return state.steps[state.currentStepIndex];
    }
    return null;
  });

  setHandler(getCheckpointQuery, (): GoalCheckpoint => ({
    goalRunId: input.goalRunId,
    version: state.replanCount + 1,
    checkpointedAt: state.lastUpdatedAt,
    phase: state.phase,
    progressSummary: {
      totalSteps: state.steps.length,
      completedSteps: state.stepResults.filter((r) => r.status === 'COMPLETED').length,
      failedSteps: state.stepResults.filter((r) => r.status === 'FAILED').length,
      percentComplete: state.steps.length > 0
        ? Math.round((state.stepResults.filter((r) => r.status === 'COMPLETED').length / state.steps.length) * 100)
        : 0,
    },
    completedWork: state.stepResults
      .filter((r) => r.status === 'COMPLETED')
      .map((r) => ({
        stepNumber: r.stepNumber,
        description: state.steps.find((s) => s.stepNumber === r.stepNumber)?.description ?? '',
        outcome: r.actualOutcome ?? '',
        completedAt: r.completedAt ?? state.lastUpdatedAt,
      })),
    currentContext: {
      lastSuccessfulStep: state.stepResults.filter((r) => r.status === 'COMPLETED').pop()?.actualOutcome,
      currentStep: state.steps[state.currentStepIndex]?.description,
      failureReason: state.failureHistory[state.failureHistory.length - 1]?.error,
      accumulatedKnowledge: state.accumulatedKnowledge,
    },
    remainingSteps: state.steps.slice(state.currentStepIndex),
  }));

  setHandler(getStepResultsQuery, (): StepResult[] => state.stepResults);

  // ============================================================================
  // Update Handlers - Phase 10.3: Synchronous Operations
  // ============================================================================

  /**
   * Resume from user prompt resolution with synchronous acknowledgment.
   * Note: this complements the userPromptResolvedSignal; prefer the Update for reliable orchestration.
   */
  setHandler(userPromptResolvedUpdate, (payload: UserPromptResolvedPayload): UserPromptResolvedResult => {
    if (!payload?.promptId) {
      return { accepted: false, applied: false, message: 'promptId is required' };
    }

    if (payload.promptId === state.lastUserPromptId) {
      return { accepted: true, applied: false, promptId: payload.promptId, message: 'duplicate promptId (noop)' };
    }

    state.lastUserPromptId = payload.promptId;
    state.pendingUserPrompts.push({ promptId: payload.promptId, answers: payload.answers });
    state.lastUpdatedAt = new Date().toISOString();

    return { accepted: true, applied: true, promptId: payload.promptId };
  });

  /**
   * Add knowledge to the workflow context.
   * Synchronous - caller waits for confirmation.
   */
  setHandler(addKnowledgeUpdate, (payload: AddKnowledgePayload): string[] => {
    const source = payload.source ?? 'external';
    const newKnowledge = payload.knowledge.map((k) => `[${source}] ${k}`);
    state.accumulatedKnowledge.push(...newKnowledge);
    state.lastUpdatedAt = new Date().toISOString();
    return state.accumulatedKnowledge;
  });

  /**
   * Modify steps during execution.
   * Validates the request and returns synchronous confirmation.
   */
  setHandler(
    modifyStepsUpdate,
    (payload: ModifyStepsPayload): ModifyStepsResult => {
      // Cannot modify if already completed or cancelled
      if (state.phase === 'COMPLETED' || state.phase === 'CANCELLED' || state.phase === 'FAILED') {
        return {
          accepted: false,
          message: `Cannot modify steps in ${state.phase} state`,
        };
      }

      let modified = false;
      const messages: string[] = [];

      // Skip steps
      if (payload.skipSteps && payload.skipSteps.length > 0) {
        for (const stepNum of payload.skipSteps) {
          const stepIndex = state.steps.findIndex((s) => s.stepNumber === stepNum);
          if (stepIndex !== -1 && stepIndex > state.currentStepIndex) {
            const result = state.stepResults[stepIndex];
            if (result && result.status === 'PENDING') {
              result.status = 'SKIPPED';
              result.completedAt = new Date().toISOString();
              result.error = 'Skipped by user request';
              modified = true;
              messages.push(`Skipped step ${stepNum}`);
            }
          }
        }
      }

      // Prioritize a step (move it to be next)
      if (payload.prioritizeStep !== undefined) {
        const targetIndex = state.steps.findIndex((s) => s.stepNumber === payload.prioritizeStep);
        if (targetIndex > state.currentStepIndex + 1) {
          // Move the step to be next
          const [step] = state.steps.splice(targetIndex, 1);
          const [result] = state.stepResults.splice(targetIndex, 1);
          state.steps.splice(state.currentStepIndex + 1, 0, step);
          state.stepResults.splice(state.currentStepIndex + 1, 0, result);
          modified = true;
          messages.push(`Prioritized step ${payload.prioritizeStep} to run next`);
        }
      }

      // Add new steps
      if (payload.addSteps && payload.addSteps.length > 0) {
        for (const newStep of payload.addSteps) {
          const insertIndex = state.steps.findIndex((s) => s.stepNumber === newStep.insertAfter);
          if (insertIndex !== -1) {
            const newStepNumber = Math.max(...state.steps.map((s) => s.stepNumber)) + 1;
            const step: Step = {
              stepNumber: newStepNumber,
              description: newStep.description,
              isHighRisk: false,
              dependencies: [],
            };
            const result: StepResult = {
              stepNumber: newStepNumber,
              status: 'PENDING',
              retryCount: 0,
              artifacts: [],
            };
            state.steps.splice(insertIndex + 1, 0, step);
            state.stepResults.splice(insertIndex + 1, 0, result);
            modified = true;
            messages.push(`Added new step ${newStepNumber} after step ${newStep.insertAfter}`);
          }
        }
      }

      state.lastUpdatedAt = new Date().toISOString();

      return {
        accepted: modified,
        message: modified ? messages.join('; ') : 'No modifications applied',
        newStepOrder: state.steps.map((s) => s.stepNumber),
      };
    },
    {
      // Validator: Check if modification is safe
      validator: (payload: ModifyStepsPayload): void => {
        if (payload.skipSteps?.some((n) => n < 1)) {
          throw new Error('Invalid step number: must be >= 1');
        }
        if (payload.prioritizeStep !== undefined && payload.prioritizeStep < 1) {
          throw new Error('Invalid prioritize step number');
        }
      },
    }
  );

  /**
   * Force an immediate checkpoint.
   * Returns full checkpoint data synchronously.
   */
  setHandler(forceCheckpointUpdate, (): GoalCheckpoint => {
    state.lastUpdatedAt = new Date().toISOString();
    return {
      goalRunId: input.goalRunId,
      version: state.replanCount + 1,
      checkpointedAt: state.lastUpdatedAt,
      phase: state.phase,
      progressSummary: {
        totalSteps: state.steps.length,
        completedSteps: state.stepResults.filter((r) => r.status === 'COMPLETED').length,
        failedSteps: state.stepResults.filter((r) => r.status === 'FAILED').length,
        percentComplete: state.steps.length > 0
          ? Math.round((state.stepResults.filter((r) => r.status === 'COMPLETED').length / state.steps.length) * 100)
          : 0,
      },
      completedWork: state.stepResults
        .filter((r) => r.status === 'COMPLETED')
        .map((r) => ({
          stepNumber: r.stepNumber,
          description: state.steps.find((s) => s.stepNumber === r.stepNumber)?.description ?? '',
          outcome: r.actualOutcome ?? '',
          completedAt: r.completedAt ?? state.lastUpdatedAt,
        })),
      currentContext: {
        lastSuccessfulStep: state.stepResults.filter((r) => r.status === 'COMPLETED').pop()?.actualOutcome,
        currentStep: state.steps[state.currentStepIndex]?.description,
        failureReason: state.failureHistory[state.failureHistory.length - 1]?.error,
        accumulatedKnowledge: state.accumulatedKnowledge,
      },
      remainingSteps: state.steps.slice(state.currentStepIndex),
    };
  });

  /**
   * Request workflow to pause at next safe point.
   * Returns acknowledgment with expected pause location.
   */
  setHandler(requestPauseUpdate, (): PauseRequestResult => {
    state.isPaused = true;
    state.lastUpdatedAt = new Date().toISOString();

    let willPauseAt: string;
    if (state.isAwaitingApproval) {
      willPauseAt = 'Already paused - awaiting approval';
    } else if (state.phase === 'EXECUTING') {
      willPauseAt = `After completing step ${state.currentStepIndex + 1}`;
    } else if (state.phase === 'PLANNING') {
      willPauseAt = 'After planning completes';
    } else {
      willPauseAt = 'At next loop iteration';
    }

    return {
      willPauseAt,
      currentPhase: state.phase,
      acknowledgment: `Pause requested at ${state.lastUpdatedAt}`,
    };
  });

  // ============================================================================
  // Capability Probe Mode (Runtime rollout guardrail)
  // ============================================================================

  // This mode exists to let the orchestrator verify that:
  // 1) the worker can run `goalRunWorkflow` on the target task queue, and
  // 2) the `userPromptResolved` Update handler is registered and callable.
  //
  // In CAPABILITY_PROBE mode we intentionally avoid activities (no DB writes, no Kafka emits, no planning).
  if (input.mode === 'CAPABILITY_PROBE') {
    state.phase = 'WAITING_USER_INPUT' as GoalRunPhase;
    state.isWaitingUserInput = true;
    state.waitingUserInputReason = 'GOAL_INTAKE';
    state.lastUpdatedAt = new Date().toISOString();

    await condition(() => state.pendingUserPrompts.length > 0 || state.isCancelled);

    const completedAt = new Date().toISOString();
    const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(state.startedAt).getTime());

    return {
      goalRunId: input.goalRunId,
      status: state.isCancelled ? 'CANCELLED' : 'COMPLETED',
      completedAt,
      summary: state.isCancelled ? 'CAPABILITY_PROBE_CANCELLED' : 'CAPABILITY_PROBE_OK',
      stepsCompleted: 0,
      totalDurationMs: durationMs,
      finalOutcome: state.isCancelled ? state.cancelReason ?? undefined : undefined,
      artifacts: [],
      knowledgeGained: [],
    };
  }

  // ============================================================================
  // Emit Start Event
  // ============================================================================

  try {
    await kafkaActivities.emitGoalEvent({
      eventType: 'GOAL_STARTED',
      goalRunId: input.goalRunId,
      tenantId: input.tenantId,
      payload: {
        goalDescription: input.goalDescription,
        workflowId,
        runId,
      },
    });
  } catch (e) {
    // Non-critical - continue workflow even if event fails
  }

  // ============================================================================
  // Main PEVR Loop
  // ============================================================================

  try {
    while (!state.isCancelled) {
      // Check for pause
      if (state.isPaused) {
        await kafkaActivities.emitGoalEvent({
          eventType: 'GOAL_PAUSED',
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
          payload: {},
        }).catch(() => {});

        await condition(() => !state.isPaused || state.isCancelled);

        if (!state.isCancelled) {
          await kafkaActivities.emitGoalEvent({
            eventType: 'GOAL_RESUMED',
            goalRunId: input.goalRunId,
            tenantId: input.tenantId,
            payload: {},
          }).catch(() => {});
        }
        continue;
      }

      // Durable WAIT for user input (Stark Fix Atom 6)
      if (state.phase === ('WAITING_USER_INPUT' as GoalRunPhase)) {
        state.isWaitingUserInput = true;
        state.lastUpdatedAt = new Date().toISOString();

        if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
          upsertSearchAttributes(createPhaseUpdate('WAITING_USER_INPUT'));
        }

        await condition(() => state.pendingUserPrompts.length > 0 || state.isCancelled || state.isPaused);

        if (state.isCancelled || state.isPaused) {
          continue;
        }

        const resolved = state.pendingUserPrompts.shift();
        if (resolved) {
          state.accumulatedKnowledge.push(`[USER_INPUT] ${JSON.stringify(resolved.answers)}`);
        }

        const resumePhaseAttribute =
          state.waitingUserInputReason === 'GOAL_INTAKE' ? 'INITIALIZING' : 'EXECUTING';
        const resumePhase = resumePhaseAttribute as GoalRunPhase;

        state.isWaitingUserInput = false;
        state.waitingUserInputForStep = null;
        state.waitingUserInputReason = null;
        state.phase = resumePhase;
        state.lastUpdatedAt = new Date().toISOString();

        if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
          upsertSearchAttributes(createPhaseUpdate(resumePhaseAttribute));
        }

        continue;
      }

      // Check cancellation
      if (state.isCancelled) {
        break;
      }

      // ========================================================================
      // PLAN Phase
      // ========================================================================

      if (state.phase === 'INITIALIZING' || state.phase === 'REPLANNING') {
        state.phase = 'PLANNING' as GoalRunPhase;
        state.lastUpdatedAt = new Date().toISOString();

        // Phase 10.2 + 10.5: Version-safe search attribute update
        // Using patched() ensures old workflows complete without this code path
        if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
          upsertSearchAttributes(createPhaseUpdate('PLANNING'));
        }

        const planResult = await planningActivities.planGoal({
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
          goalDescription: input.goalDescription,
          previousFailures: state.failureHistory,
          accumulatedKnowledge: state.accumulatedKnowledge,
          constraints: { maxSteps: constraints.maxSteps },
        });

        if (planResult.kind === 'GOAL_INTAKE_REQUIRED') {
          state.steps = [];
          state.stepResults = [];
          state.currentStepIndex = 0;
          state.isWaitingUserInput = true;
          state.waitingUserInputForStep = null;
          state.waitingUserInputReason = 'GOAL_INTAKE';
          state.phase = 'WAITING_USER_INPUT' as GoalRunPhase;
          state.lastUpdatedAt = new Date().toISOString();

          if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
            upsertSearchAttributes(createPhaseUpdate('WAITING_USER_INPUT'));
          }

          continue;
        }

        state.steps = planResult.steps;
        state.stepResults = planResult.steps.map((step) => ({
          stepNumber: step.stepNumber,
          status: 'PENDING' as const,
          retryCount: 0,
          artifacts: [],
        }));
        state.currentStepIndex = 0;
        state.phase = 'EXECUTING' as GoalRunPhase;
        state.lastUpdatedAt = new Date().toISOString();

        // Phase 10.2 + 10.5: Version-safe search attribute update
        if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
          const hasHighRiskSteps = state.steps.some((step) => step.isHighRisk);
          upsertSearchAttributes(createPlanSearchAttributes(state.steps.length, hasHighRiskSteps));
        }
      }

      // ========================================================================
      // EXECUTE Phase
      // ========================================================================

      if (state.phase === 'EXECUTING' && state.currentStepIndex < state.steps.length) {
        const currentStep = state.steps[state.currentStepIndex];
        const currentResult = state.stepResults[state.currentStepIndex];

        // Update step status
        currentResult.status = 'IN_PROGRESS';
        currentResult.startedAt = new Date().toISOString();
        state.lastUpdatedAt = new Date().toISOString();

        // Emit step started event
        await kafkaActivities.emitStepEvent({
          eventType: 'STEP_STARTED',
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
          stepNumber: currentStep.stepNumber,
          payload: { description: currentStep.description },
        }).catch(() => {});

        // Check if high-risk step requires approval
        if (currentStep.isHighRisk && constraints.requireApprovalForHighRisk) {
          state.isAwaitingApproval = true;
          state.approvalStepId = `step-${currentStep.stepNumber}`;
          state.approvalResult = null;
          state.rejectionReason = null;

          // Phase 10.2 + 10.5: Version-safe search attribute update
          if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
            upsertSearchAttributes(createApprovalStateUpdate(true));
          }

          await kafkaActivities.emitStepEvent({
            eventType: 'STEP_APPROVAL_REQUESTED',
            goalRunId: input.goalRunId,
            tenantId: input.tenantId,
            stepNumber: currentStep.stepNumber,
            payload: { description: currentStep.description, isHighRisk: true },
          }).catch(() => {});

          // Wait for approval (with timeout)
          const approved = await condition(
            () => state.approvalResult !== null || state.isCancelled,
            '24h' // 24 hour approval timeout
          );

          // Phase 10.2 + 10.5: Version-safe search attribute update
          if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
            upsertSearchAttributes(createApprovalStateUpdate(false));
          }

          if (state.isCancelled) {
            break;
          }

          if (state.approvalResult === 'REJECTED') {
            await kafkaActivities.emitStepEvent({
              eventType: 'STEP_REJECTED',
              goalRunId: input.goalRunId,
              tenantId: input.tenantId,
              stepNumber: currentStep.stepNumber,
              payload: { reason: state.rejectionReason },
            }).catch(() => {});

            // Skip this step and continue
            currentResult.status = 'SKIPPED';
            currentResult.completedAt = new Date().toISOString();
            currentResult.error = `Rejected: ${state.rejectionReason}`;
            state.currentStepIndex++;
            continue;
          }

          await kafkaActivities.emitStepEvent({
            eventType: 'STEP_APPROVED',
            goalRunId: input.goalRunId,
            tenantId: input.tenantId,
            stepNumber: currentStep.stepNumber,
            payload: {},
          }).catch(() => {});
        }

        // Execute the step
        try {
          const executeResult = await executionActivities.executeStep({
            goalRunId: input.goalRunId,
            tenantId: input.tenantId,
            step: currentStep,
            workspaceId: input.workspaceId,
            context: {
              previousStepOutcome: state.stepResults[state.currentStepIndex - 1]?.actualOutcome,
              accumulatedKnowledge: state.accumulatedKnowledge,
            },
          });

          if (executeResult.success) {
            currentResult.status = 'COMPLETED';
            currentResult.actualOutcome = executeResult.outcome;
            currentResult.artifacts = executeResult.artifacts;
            currentResult.completedAt = new Date().toISOString();

            // Add knowledge gained
            state.accumulatedKnowledge.push(...executeResult.knowledgeGained);

            await kafkaActivities.emitStepEvent({
              eventType: 'STEP_COMPLETED',
              goalRunId: input.goalRunId,
              tenantId: input.tenantId,
              stepNumber: currentStep.stepNumber,
              payload: { outcome: executeResult.outcome },
            }).catch(() => {});

            // ================================================================
            // VERIFY Phase (inline for efficiency)
            // ================================================================

            state.phase = 'VERIFYING' as GoalRunPhase;
            state.lastUpdatedAt = new Date().toISOString();

            const verifyResult = await executionActivities.verifyStep({
              goalRunId: input.goalRunId,
              tenantId: input.tenantId,
              step: currentStep,
              executionResult: executeResult,
            });

            if (verifyResult.verified) {
              // Move to next step
              state.currentStepIndex++;
              state.phase = 'EXECUTING' as GoalRunPhase;
              state.lastUpdatedAt = new Date().toISOString();
            } else if (verifyResult.suggestReplan) {
              // Need to replan
              if (state.replanCount >= constraints.maxReplans) {
                throw ApplicationFailure.create({
                  type: 'MAX_REPLANS_EXCEEDED',
                  message: `Exceeded maximum replans (${constraints.maxReplans})`,
                });
              }

              state.replanCount++;
              state.failureHistory.push({
                stepNumber: currentStep.stepNumber,
                error: verifyResult.replanReason ?? 'Verification failed',
              });
              state.phase = 'REPLANNING' as GoalRunPhase;
              state.lastUpdatedAt = new Date().toISOString();
            } else {
              // Retry the step
              currentResult.retryCount++;
              if (currentResult.retryCount >= constraints.maxRetries) {
                throw ApplicationFailure.create({
                  type: 'MAX_RETRIES_EXCEEDED',
                  message: `Step ${currentStep.stepNumber} exceeded maximum retries`,
                });
              }
              // Sleep with exponential backoff before retry
              await sleep(`${Math.min(30000, 1000 * Math.pow(2, currentResult.retryCount))}ms`);
            }
          } else {
            if (executeResult.waitingForUserInput || executeResult.needsApproval) {
              // Stark Fix (Atom 6): Treat "needs help" as a durable WAIT state, not a failure/retry loop.
              currentResult.status = 'PENDING';
              currentResult.error = 'WAITING_USER_INPUT';
              state.isWaitingUserInput = true;
              state.waitingUserInputForStep = currentStep.stepNumber;
              state.waitingUserInputReason = 'STEP_INPUT';
              state.phase = 'WAITING_USER_INPUT' as GoalRunPhase;
              state.lastUpdatedAt = new Date().toISOString();
              continue;
            }

            // Step failed
            currentResult.status = 'FAILED';
            currentResult.error = executeResult.error;
            currentResult.completedAt = new Date().toISOString();

            await kafkaActivities.emitStepEvent({
              eventType: 'STEP_FAILED',
              goalRunId: input.goalRunId,
              tenantId: input.tenantId,
              stepNumber: currentStep.stepNumber,
              payload: { error: executeResult.error },
            }).catch(() => {});

            // Classify failure and decide action
            if (currentResult.retryCount < constraints.maxRetries) {
              currentResult.retryCount++;
              currentResult.status = 'PENDING';
              await sleep(`${Math.min(30000, 1000 * Math.pow(2, currentResult.retryCount))}ms`);
            } else {
              // Try replanning
              if (state.replanCount < constraints.maxReplans) {
                state.replanCount++;
                state.failureHistory.push({
                  stepNumber: currentStep.stepNumber,
                  error: executeResult.error ?? 'Step execution failed',
                });
                state.phase = 'REPLANNING' as GoalRunPhase;
                state.lastUpdatedAt = new Date().toISOString();
              } else {
                throw ApplicationFailure.create({
                  type: 'STEP_PERMANENTLY_FAILED',
                  message: `Step ${currentStep.stepNumber} failed permanently after ${constraints.maxRetries} retries and ${constraints.maxReplans} replans`,
                });
              }
            }
          }
        } catch (error) {
          if (isCancellation(error)) {
            throw error;
          }

          currentResult.status = 'FAILED';
          currentResult.error = error instanceof Error ? error.message : String(error);
          currentResult.completedAt = new Date().toISOString();

          await kafkaActivities.emitStepEvent({
            eventType: 'STEP_FAILED',
            goalRunId: input.goalRunId,
            tenantId: input.tenantId,
            stepNumber: currentStep.stepNumber,
            payload: { error: currentResult.error },
          }).catch(() => {});

          throw error;
        }
      }

      // Check if all steps completed
      if (state.currentStepIndex >= state.steps.length) {
        state.phase = 'COMPLETED' as GoalRunPhase;
        state.lastUpdatedAt = new Date().toISOString();
        break;
      }
    }

    // ============================================================================
    // Build Result
    // ============================================================================

    const completedSteps = state.stepResults.filter((r) => r.status === 'COMPLETED').length;
    const allArtifacts = state.stepResults.flatMap((r) =>
      r.artifacts.map((path) => ({ type: 'file', path, description: undefined }))
    );

    if (state.isCancelled) {
      // Phase 10.2 + 10.5: Version-safe search attribute update
      if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
        upsertSearchAttributes(createPhaseUpdate('CANCELLED'));
      }

      await kafkaActivities.emitGoalEvent({
        eventType: 'GOAL_CANCELLED',
        goalRunId: input.goalRunId,
        tenantId: input.tenantId,
        payload: { reason: state.cancelReason },
      }).catch(() => {});

      return {
        goalRunId: input.goalRunId,
        status: 'CANCELLED',
        completedAt: new Date().toISOString(),
        summary: `Goal cancelled: ${state.cancelReason}`,
        stepsCompleted: completedSteps,
        totalDurationMs: Date.now() - new Date(state.startedAt).getTime(),
        artifacts: allArtifacts,
        knowledgeGained: state.accumulatedKnowledge,
      };
    }

    // Phase 10.2 + 10.5: Version-safe search attribute update
    if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
      upsertSearchAttributes(createPhaseUpdate('COMPLETED'));
    }

    await kafkaActivities.emitGoalEvent({
      eventType: 'GOAL_COMPLETED',
      goalRunId: input.goalRunId,
      tenantId: input.tenantId,
      payload: {
        stepsCompleted: completedSteps,
        totalSteps: state.steps.length,
      },
    }).catch(() => {});

    return {
      goalRunId: input.goalRunId,
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      summary: `Successfully completed ${completedSteps}/${state.steps.length} steps`,
      stepsCompleted: completedSteps,
      totalDurationMs: Date.now() - new Date(state.startedAt).getTime(),
      finalOutcome: state.stepResults[state.stepResults.length - 1]?.actualOutcome,
      artifacts: allArtifacts,
      knowledgeGained: state.accumulatedKnowledge,
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = error instanceof ApplicationFailure ? error.type ?? 'UNKNOWN' : 'UNKNOWN';

    // Phase 10.2 + 10.5: Version-safe search attribute update
    if (patched(WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES)) {
      upsertSearchAttributes(createErrorSearchAttributes(errorType));
    }

    await kafkaActivities.emitGoalEvent({
      eventType: 'GOAL_FAILED',
      goalRunId: input.goalRunId,
      tenantId: input.tenantId,
      payload: {
        errorType,
        errorMessage,
        failedStep: state.currentStepIndex,
      },
    }).catch(() => {});

    return {
      goalRunId: input.goalRunId,
      status: 'FAILED',
      completedAt: new Date().toISOString(),
      summary: `Goal failed: ${errorMessage}`,
      stepsCompleted: state.stepResults.filter((r) => r.status === 'COMPLETED').length,
      totalDurationMs: Date.now() - new Date(state.startedAt).getTime(),
      errorDetails: {
        errorType,
        errorMessage,
        failedStep: state.currentStepIndex,
        recoverable: errorType !== 'FATAL_ERROR',
      },
      artifacts: [],
      knowledgeGained: state.accumulatedKnowledge,
    };
  }
}
