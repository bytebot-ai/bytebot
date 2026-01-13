import { OrchestratorLoopService } from './orchestrator-loop.service';
import { GoalRunPhase } from '@prisma/client';

describe('OrchestratorLoopService Goal Intake gate before planning', () => {
  it('does not enter PLANNING when GoalSpec is INCOMPLETE', async () => {
    const prisma = {
      goalRun: {
        updateMany: jest.fn(),
      },
    } as any;

    const goalRunService = {
      updatePhase: jest.fn(),
      failGoalRun: jest.fn(),
    } as any;

    const plannerService = {
      generateInitialPlan: jest.fn(),
    } as any;

    const goalIntakeService = {
      ensureGoalSpecReadyForPlanning: jest.fn(),
      requestGoalIntakeFromPlannerError: jest.fn(),
    } as any;

    const service = new OrchestratorLoopService(
      prisma,
      goalRunService,
      plannerService,
      goalIntakeService,
      {} as any,
      {} as any,
      { isInBackoff: () => false } as any,
      { shouldSkipExecution: () => false } as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
      { get: jest.fn((_key: string, fallback: any) => fallback) } as any,
      {} as any,
      {} as any,
    );

    goalIntakeService.ensureGoalSpecReadyForPlanning.mockResolvedValueOnce({
      ready: false,
      goalSpecId: 'gs-1',
      promptId: 'p-1',
    });

    await (service as any).executePlanningPhase({ id: 'gr-1', tenantId: 't-1', phase: GoalRunPhase.INITIALIZING });

    expect(goalIntakeService.ensureGoalSpecReadyForPlanning).toHaveBeenCalledWith({
      goalRunId: 'gr-1',
      tenantId: 't-1',
    });

    // No planning lock acquired, no plan generation started
    expect(prisma.goalRun.updateMany).not.toHaveBeenCalled();
    expect(plannerService.generateInitialPlan).not.toHaveBeenCalled();
    expect(goalRunService.updatePhase).not.toHaveBeenCalled();
    expect(goalRunService.failGoalRun).not.toHaveBeenCalled();
  });
});

