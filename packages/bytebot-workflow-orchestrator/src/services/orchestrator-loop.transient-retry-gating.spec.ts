import { OrchestratorLoopService } from './orchestrator-loop.service';
import { ChecklistItemStatus, GoalRunPhase } from '@prisma/client';

describe('OrchestratorLoopService transient retry gating', () => {
  it('does not EXECUTE a PENDING step before its retry gate expires', async () => {
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

    const gateUntil = new Date(Date.now() + 60_000);
    const goalRun: any = {
      id: 'gr-1',
      phase: GoalRunPhase.EXECUTING,
      currentPlanVersion: 1,
      planVersions: [
        {
          checklistItems: [
            {
              id: 'ci-1',
              status: ChecklistItemStatus.PENDING,
              description: 'Retry me later',
              infraRetryAfter: gateUntil,
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

