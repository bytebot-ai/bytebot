import { OrchestratorLoopService } from './orchestrator-loop.service';
import { FailureClassificationService } from './failure-classification.service';
import { ChecklistItemStatus, GoalRunPhase } from '@prisma/client';

describe('OrchestratorLoopService heartbeat exhaustion → WAITING_PROVIDER', () => {
  it('pauses safely (WAIT_PROVIDER) after heartbeat retry budget is exhausted', async () => {
    const configService = {
      get: jest.fn((key: string, fallback: any) => {
        if (key === 'ORCHESTRATOR_RESTART_GRACE_MS') return '0';
        if (key === 'HEARTBEAT_MAX_RETRIES') return '2';
        if (key === 'HEARTBEAT_BASE_DELAY_MS') return '1';
        if (key === 'HEARTBEAT_MAX_DELAY_MS') return '1';
        return fallback;
      }),
    } as any;

    const eventEmitter = { emit: jest.fn() } as any;
    const failureClassificationService = new FailureClassificationService(configService, eventEmitter);

    const taskDispatchService = {
      getHeartbeatHealth: jest.fn(() => ({
        hasActiveDispatch: true,
        isHealthy: false,
        consecutiveUnhealthy: 99,
        lastHeartbeat: undefined,
        shouldTimeout: true,
      })),
      getStatusCheckHealth: jest.fn(() => ({
        hasActiveDispatch: true,
        isHealthy: true,
        consecutiveFailures: 0,
        lastSuccessfulCheck: new Date(),
      })),
      getLastProgressTime: jest.fn(() => null),
    } as any;

    const service = new OrchestratorLoopService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      taskDispatchService,
      { isInBackoff: () => false } as any,
      { shouldSkipExecution: () => false } as any,
      failureClassificationService,
      {} as any,
      eventEmitter,
      configService,
      {} as any,
      {} as any,
    );

    const goalRun = {
      id: 'gr-1',
      phase: GoalRunPhase.EXECUTING,
      planVersions: [
        {
          checklistItems: [
            {
              id: 'ci-1',
              status: ChecklistItemStatus.IN_PROGRESS,
              description: 'Desktop step',
              startedAt: new Date(0),
            },
          ],
        },
      ],
    };

    const d1 = await (service as any).makeDecision(goalRun);
    const d2 = await (service as any).makeDecision(goalRun);
    const d3 = await (service as any).makeDecision(goalRun);

    expect(d1.action).toBe('RETRY');
    expect(d2.action).toBe('RETRY');
    expect(d3).toEqual(
      expect.objectContaining({
        action: 'WAIT_PROVIDER',
        itemId: 'ci-1',
      }),
    );
  });
});

