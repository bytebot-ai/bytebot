import { StepType } from '@prisma/client';
import { hasUserInteractionTool } from '../contracts/planner-tools';

export type PlannerChecklistItem = {
  description: string;
  type: StepType;
  expectedOutcome?: string;
  suggestedTools?: string[];
  requiresDesktop?: boolean;
};

export type PlannerFirstStepUserInputReason =
  | 'USER_INPUT_REQUIRED_TYPE'
  | 'ASK_USER_TOOL';

/**
 * Raised when the planner attempts to start a plan with a user-interaction step.
 *
 * We treat this as a GoalSpec intake requirement rather than saving a prompt-first plan.
 * This prevents runs that immediately enter WAITING_USER_INPUT with no progress.
 */
export class PlannerFirstStepUserInputError extends Error {
  readonly firstStep: PlannerChecklistItem;
  readonly mode: 'initial' | 'replan';
  readonly reason: PlannerFirstStepUserInputReason;

  constructor(params: {
    mode: 'initial' | 'replan';
    firstStep: PlannerChecklistItem;
    reason: PlannerFirstStepUserInputReason;
  }) {
    super(
      `Planner produced a prompt-first plan (${params.reason}) in ${params.mode} mode: ${params.firstStep.description}`,
    );
    this.name = 'PlannerFirstStepUserInputError';
    this.mode = params.mode;
    this.firstStep = params.firstStep;
    this.reason = params.reason;
  }
}

export function detectPlannerFirstStepUserInputReason(
  firstStep: PlannerChecklistItem,
): PlannerFirstStepUserInputReason | null {
  if (firstStep.type === StepType.USER_INPUT_REQUIRED) return 'USER_INPUT_REQUIRED_TYPE';
  if (hasUserInteractionTool(firstStep.suggestedTools)) return 'ASK_USER_TOOL';

  return null;
}
