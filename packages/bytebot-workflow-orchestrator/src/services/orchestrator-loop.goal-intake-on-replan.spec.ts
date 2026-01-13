import { OrchestratorLoopService } from './orchestrator-loop.service';
import { PlannerFirstStepUserInputError } from './planner.errors';
import { StepType } from '@prisma/client';

describe('OrchestratorLoopService GoalIntake on replanning', () => {
  it('converts prompt-first replans into goal intake prompt', async () => {
    const prisma = {} as any;

    const goalRunService = {
      createActivityEvent: jest.fn(),
      updatePhase: jest.fn(),
      failGoalRun: jest.fn(),
    } as any;

    const plannerService = {
      generateReplan: jest.fn(),
    } as any;

    const goalIntakeService = {
      requestGoalIntakeFromPlannerError: jest.fn(),
    } as any;

    const service = new OrchestratorLoopService(
      prisma,
      goalRunService,
      plannerService,
      goalIntakeService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
      { get: jest.fn((_key: string, fallback: any) => fallback) } as any,
      {} as any,
      {} as any,
    );

    const error = new PlannerFirstStepUserInputError({
      mode: 'replan',
      reason: 'USER_INPUT_REQUIRED_TYPE',
      firstStep: {
        description: 'Ask the user for missing details',
        type: StepType.USER_INPUT_REQUIRED,
        suggestedTools: ['ASK_USER'],
        requiresDesktop: false,
      },
    });

    plannerService.generateReplan.mockRejectedValueOnce(error);

    const goalRun = { id: 'gr-1', tenantId: 't-1', workflowRunId: null } as any;
    await (service as any).executeReplanningPhase(goalRun, 'Need more details', 'ci-failed');

    expect(goalIntakeService.requestGoalIntakeFromPlannerError).toHaveBeenCalledWith({
      goalRunId: 'gr-1',
      tenantId: 't-1',
      error,
    });
    expect(goalRunService.updatePhase).not.toHaveBeenCalled();
    expect(goalRunService.failGoalRun).not.toHaveBeenCalled();
  });
});

