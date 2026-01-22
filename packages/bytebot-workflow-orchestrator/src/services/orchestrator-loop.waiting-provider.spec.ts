import { OrchestratorLoopService } from './orchestrator-loop.service';
import { ChecklistItemStatus, GoalRunPhase, GoalRunWaitReason } from '@prisma/client';

describe('OrchestratorLoopService WAITING_PROVIDER gate', () => {
  it('blocks step and transitions run to WAITING_PROVIDER', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalRun: {
        updateMany: jest.fn(),
      },
    } as any;

    const goalRunService = {
      createActivityEvent: jest.fn(),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const service = new OrchestratorLoopService(
      prisma,
      goalRunService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      eventEmitter,
      configService,
      {} as any,
      {} as any,
    );

    prisma.checklistItem.findUnique.mockResolvedValueOnce({
      id: 'ci-1',
      description: 'Desktop step',
      status: ChecklistItemStatus.FAILED,
      startedAt: null,
      actualOutcome: '[INFRA] Gateway timeout',
    });

    prisma.checklistItem.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 1 });

    await (service as any).enterWaitingProvider(
      { id: 'gr-1', phase: GoalRunPhase.EXECUTING },
      'ci-1',
      'Waiting for provider capacity',
    );

    expect(prisma.checklistItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ci-1',
        status: { in: [ChecklistItemStatus.FAILED, ChecklistItemStatus.IN_PROGRESS] },
      },
      data: expect.objectContaining({
        status: ChecklistItemStatus.BLOCKED,
        completedAt: null,
      }),
    });

    expect(prisma.goalRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'gr-1',
        phase: { in: [GoalRunPhase.EXECUTING, GoalRunPhase.CONTROLLING_DESKTOP] },
      },
      data: expect.objectContaining({
        phase: GoalRunPhase.WAITING_PROVIDER,
        waitReason: GoalRunWaitReason.PROVIDER,
      }),
    });

    expect(goalRunService.createActivityEvent).toHaveBeenCalledWith(
      'gr-1',
      expect.objectContaining({
        eventType: 'WAITING_PROVIDER',
        checklistItemId: 'ci-1',
      }),
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.phase-changed', {
      goalRunId: 'gr-1',
      previousPhase: GoalRunPhase.EXECUTING,
      newPhase: GoalRunPhase.WAITING_PROVIDER,
    });
  });

  it('is idempotent: repeated calls do not re-emit activity', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalRun: {
        updateMany: jest.fn(),
      },
    } as any;

    const goalRunService = {
      createActivityEvent: jest.fn(),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const service = new OrchestratorLoopService(
      prisma,
      goalRunService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      eventEmitter,
      configService,
      {} as any,
      {} as any,
    );

    prisma.checklistItem.findUnique.mockResolvedValue({
      id: 'ci-1',
      description: 'Desktop step',
      status: ChecklistItemStatus.FAILED,
      startedAt: null,
      actualOutcome: '[INFRA] Gateway timeout',
    });

    prisma.checklistItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.goalRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await (service as any).enterWaitingProvider(
      { id: 'gr-1', phase: GoalRunPhase.EXECUTING },
      'ci-1',
      'Waiting for provider capacity',
    );
    await (service as any).enterWaitingProvider(
      { id: 'gr-1', phase: GoalRunPhase.EXECUTING },
      'ci-1',
      'Waiting for provider capacity',
    );

    expect(goalRunService.createActivityEvent).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });
});
