/**
 * ByteBot Temporal Worker - Type Definitions
 *
 * Industry-standard type definitions for durable workflow execution.
 * Follows patterns from OpenAI, Anthropic, and Manus AI.
 */

import { z } from 'zod';

// ============================================================================
// Workflow Input/Output Types
// ============================================================================

export const GoalRunInputSchema = z.object({
  goalRunId: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  goalDescription: z.string().min(1),
  workspaceId: z.string().optional(),
  constraints: z.object({
    maxSteps: z.number().int().positive().default(50),
    maxRetries: z.number().int().nonnegative().default(3),
    maxReplans: z.number().int().nonnegative().default(3),
    timeoutMs: z.number().int().positive().default(3600000), // 1 hour
    requireApprovalForHighRisk: z.boolean().default(true),
  }).optional(),
  context: z.object({
    previousAttempts: z.number().int().nonnegative().default(0),
    parentGoalRunId: z.string().optional(),
    inheritedKnowledge: z.array(z.string()).default([]),
  }).optional(),
  // Runtime-only: allows starting a "capability probe" workflow execution that does not
  // call activities or mutate external systems, but still validates Update handler registration.
  mode: z.enum(['NORMAL', 'CAPABILITY_PROBE']).optional(),
});

export type GoalRunInput = z.infer<typeof GoalRunInputSchema>;

export const GoalRunResultSchema = z.object({
  goalRunId: z.string(),
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT']),
  completedAt: z.string().datetime(),
  summary: z.string(),
  stepsCompleted: z.number().int().nonnegative(),
  totalDurationMs: z.number().int().nonnegative(),
  finalOutcome: z.string().optional(),
  errorDetails: z.object({
    errorType: z.string(),
    errorMessage: z.string(),
    failedStep: z.number().int().optional(),
    recoverable: z.boolean(),
  }).optional(),
  artifacts: z.array(z.object({
    type: z.string(),
    path: z.string(),
    description: z.string().optional(),
  })).default([]),
  knowledgeGained: z.array(z.string()).default([]),
});

export type GoalRunResult = z.infer<typeof GoalRunResultSchema>;

// ============================================================================
// Workflow State Types
// ============================================================================

export enum GoalRunPhase {
  INITIALIZING = 'INITIALIZING',
  PLANNING = 'PLANNING',
  EXECUTING = 'EXECUTING',
  WAITING_USER_INPUT = 'WAITING_USER_INPUT',
  VERIFYING = 'VERIFYING',
  REPLANNING = 'REPLANNING',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export const StepSchema = z.object({
  stepNumber: z.number().int().positive(),
  description: z.string(),
  expectedOutcome: z.string().optional(),
  isHighRisk: z.boolean().default(false),
  dependencies: z.array(z.number().int().positive()).default([]),
  estimatedDurationMs: z.number().int().positive().optional(),
});

export type Step = z.infer<typeof StepSchema>;

export const StepResultSchema = z.object({
  stepNumber: z.number().int().positive(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED']),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  actualOutcome: z.string().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  artifacts: z.array(z.string()).default([]),
});

export type StepResult = z.infer<typeof StepResultSchema>;

export const GoalProgressSchema = z.object({
  goalRunId: z.string(),
  phase: z.nativeEnum(GoalRunPhase),
  currentStep: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  completedSteps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  percentComplete: z.number().min(0).max(100),
  startedAt: z.string().datetime(),
  lastUpdatedAt: z.string().datetime(),
  estimatedCompletionAt: z.string().datetime().optional(),
  isPaused: z.boolean().default(false),
  isAwaitingApproval: z.boolean().default(false),
  isWaitingUserInput: z.boolean().default(false),
});

export type GoalProgress = z.infer<typeof GoalProgressSchema>;

// ============================================================================
// Checkpoint Types (Manus-style persistence)
// ============================================================================

export const GoalCheckpointSchema = z.object({
  goalRunId: z.string(),
  version: z.number().int().positive(),
  checkpointedAt: z.string().datetime(),
  phase: z.nativeEnum(GoalRunPhase),

  progressSummary: z.object({
    totalSteps: z.number().int().nonnegative(),
    completedSteps: z.number().int().nonnegative(),
    failedSteps: z.number().int().nonnegative(),
    percentComplete: z.number().min(0).max(100),
  }),

  completedWork: z.array(z.object({
    stepNumber: z.number().int().positive(),
    description: z.string(),
    outcome: z.string(),
    completedAt: z.string().datetime(),
  })),

  currentContext: z.object({
    lastSuccessfulStep: z.string().optional(),
    lastSuccessfulOutcome: z.string().optional(),
    currentStep: z.string().optional(),
    failureReason: z.string().optional(), // "Leave wrong turns in context" - Manus pattern
    accumulatedKnowledge: z.array(z.string()),
  }),

  remainingSteps: z.array(StepSchema),

  plan: z.object({
    originalPlan: z.string(),
    currentPlan: z.string(),
    replanCount: z.number().int().nonnegative(),
  }).optional(),
});

export type GoalCheckpoint = z.infer<typeof GoalCheckpointSchema>;

// ============================================================================
// Signal Payload Types
// ============================================================================

export const ApproveStepPayloadSchema = z.object({
  stepId: z.string(),
  approver: z.string(),
  comment: z.string().optional(),
  approvedAt: z.string().datetime().optional(),
});

export type ApproveStepPayload = z.infer<typeof ApproveStepPayloadSchema>;

export const RejectStepPayloadSchema = z.object({
  stepId: z.string(),
  reason: z.string(),
  rejector: z.string().optional(),
  rejectedAt: z.string().datetime().optional(),
});

export type RejectStepPayload = z.infer<typeof RejectStepPayloadSchema>;

export const CancelGoalPayloadSchema = z.object({
  reason: z.string(),
  cancelledBy: z.string().optional(),
  cancelledAt: z.string().datetime().optional(),
});

export type CancelGoalPayload = z.infer<typeof CancelGoalPayloadSchema>;

export const SteerPayloadSchema = z.object({
  instruction: z.string(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  addToContext: z.boolean().default(true),
});

export type SteerPayload = z.infer<typeof SteerPayloadSchema>;

// ============================================================================
// Activity Input/Output Types
// ============================================================================

export const PlanGoalInputSchema = z.object({
  goalRunId: z.string(),
  tenantId: z.string(),
  goalDescription: z.string(),
  previousFailures: z.array(z.object({
    stepNumber: z.number().int(),
    error: z.string(),
  })).default([]),
  accumulatedKnowledge: z.array(z.string()).default([]),
  constraints: z.object({
    maxSteps: z.number().int().positive(),
  }).optional(),
});

export type PlanGoalInput = z.infer<typeof PlanGoalInputSchema>;

export const PlanGoalOutputPlanSchema = z.object({
  kind: z.literal('PLAN'),
  steps: z.array(StepSchema),
  planSummary: z.string(),
  estimatedDurationMs: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Phase 13.3: Assessment of whether the task is achievable with desktop agent capabilities */
  capabilityAssessment: z.string().optional(),
});

export const PlanGoalOutputGoalIntakeSchema = z.object({
  kind: z.literal('GOAL_INTAKE_REQUIRED'),
  promptId: z.string().min(1),
  goalSpecId: z.string().min(1),
  reason: z.string().min(1),
});

// Stark contract: planning may return a durable Goal Intake request instead of steps.
export const PlanGoalOutputSchema = z.union([
  PlanGoalOutputPlanSchema,
  PlanGoalOutputGoalIntakeSchema,
]);

export type PlanGoalOutput = z.infer<typeof PlanGoalOutputSchema>;

export const ExecuteStepInputSchema = z.object({
  goalRunId: z.string(),
  tenantId: z.string(),
  step: StepSchema,
  workspaceId: z.string().optional(),
  context: z.object({
    previousStepOutcome: z.string().optional(),
    accumulatedKnowledge: z.array(z.string()),
  }).optional(),
});

export type ExecuteStepInput = z.infer<typeof ExecuteStepInputSchema>;

export const ExecuteStepOutputSchema = z.object({
  success: z.boolean(),
  outcome: z.string(),
  artifacts: z.array(z.string()).default([]),
  knowledgeGained: z.array(z.string()).default([]),
  needsApproval: z.boolean().default(false),
  waitingForUserInput: z.boolean().default(false),
  error: z.string().optional(),
});

export type ExecuteStepOutput = z.infer<typeof ExecuteStepOutputSchema>;

export const VerifyStepInputSchema = z.object({
  goalRunId: z.string(),
  tenantId: z.string(),
  step: StepSchema,
  executionResult: ExecuteStepOutputSchema,
});

export type VerifyStepInput = z.infer<typeof VerifyStepInputSchema>;

export const VerifyStepOutputSchema = z.object({
  verified: z.boolean(),
  verificationDetails: z.string(),
  suggestReplan: z.boolean().default(false),
  replanReason: z.string().optional(),
});

export type VerifyStepOutput = z.infer<typeof VerifyStepOutputSchema>;

// ============================================================================
// Kafka Event Types
// ============================================================================

export const GoalEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum([
    'GOAL_STARTED',
    'GOAL_COMPLETED',
    'GOAL_FAILED',
    'GOAL_CANCELLED',
    'GOAL_PAUSED',
    'GOAL_RESUMED',
  ]),
  goalRunId: z.string(),
  tenantId: z.string(),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
});

export type GoalEvent = z.infer<typeof GoalEventSchema>;

export const StepEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum([
    'STEP_STARTED',
    'STEP_COMPLETED',
    'STEP_FAILED',
    'STEP_SKIPPED',
    'STEP_APPROVAL_REQUESTED',
    'STEP_APPROVED',
    'STEP_REJECTED',
  ]),
  goalRunId: z.string(),
  tenantId: z.string(),
  stepNumber: z.number().int(),
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
});

export type StepEvent = z.infer<typeof StepEventSchema>;

export const AuditEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  goalRunId: z.string(),
  tenantId: z.string(),
  userId: z.string().optional(),
  timestamp: z.string().datetime(),
  action: z.string(),
  details: z.record(z.unknown()),
  metadata: z.object({
    workflowId: z.string().optional(),
    runId: z.string().optional(),
    activityId: z.string().optional(),
  }).optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ============================================================================
// Failure Classification Types (Google SRE pattern)
// ============================================================================

export enum FailureCategory {
  TRANSIENT = 'TRANSIENT',
  SEMANTIC = 'SEMANTIC',
  PERMANENT = 'PERMANENT',
}

export enum FailureType {
  // Transient
  HEARTBEAT_TIMEOUT = 'HEARTBEAT_TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  AGENT_UNREACHABLE = 'AGENT_UNREACHABLE',

  // Semantic
  STEP_FAILED = 'STEP_FAILED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  ASSERTION_FAILED = 'ASSERTION_FAILED',
  NEEDS_HELP = 'NEEDS_HELP',
  WRONG_APPROACH = 'WRONG_APPROACH',

  // Permanent
  RESOURCE_DELETED = 'RESOURCE_DELETED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED',
  GOAL_CANCELLED = 'GOAL_CANCELLED',
  FATAL_ERROR = 'FATAL_ERROR',
}

export const FailureClassificationSchema = z.object({
  category: z.nativeEnum(FailureCategory),
  type: z.nativeEnum(FailureType),
  retryable: z.boolean(),
  suggestedAction: z.enum(['RETRY', 'REPLAN', 'FAIL', 'ASK_HUMAN']),
  maxRetries: z.number().int().nonnegative().optional(),
  backoffMs: z.number().int().nonnegative().optional(),
});

export type FailureClassification = z.infer<typeof FailureClassificationSchema>;
