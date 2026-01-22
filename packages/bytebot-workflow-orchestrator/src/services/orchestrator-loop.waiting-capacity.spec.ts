import { OrchestratorLoopService } from './orchestrator-loop.service';
import { ChecklistItemStatus, GoalRunPhase } from '@prisma/client';

describe('OrchestratorLoopService WAITING_CAPACITY quiet gate', () => {
  it('does not attempt to execute steps before waitUntil (quiet waiting)', async () => {
    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;

    const service = new OrchestratorLoopService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isInBackoff: () => false } as any,
      { shouldSkipExecution: () => false } as any,
      {} as any,
      {} as any,
      { emit: jest.fn() } as any,
      configService,
      {} as any,
      {} as any,
    );

    const goalRun: any = {
      id: 'gr-1',
      phase: GoalRunPhase.WAITING_CAPACITY,
      waitUntil: new Date(Date.now() + 60_000),
      currentPlanVersion: 1,
      planVersions: [
        {
          checklistItems: [
            {
              id: 'ci-1',
              status: ChecklistItemStatus.PENDING,
              description: 'Await capacity',
              infraRetryAfter: null,
              heartbeatRetryAfter: null,
            },
          ],
        },
      ],
    };

    const decision = await (service as any).makeDecision(goalRun);
    expect(decision).toEqual({ action: 'CONTINUE' });
  });
});

