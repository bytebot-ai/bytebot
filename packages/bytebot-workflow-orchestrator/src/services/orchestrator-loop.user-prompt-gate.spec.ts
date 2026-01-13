import { OrchestratorLoopService } from './orchestrator-loop.service';
import {
  ChecklistItemStatus,
  ExecutionSurface,
  GoalRunPhase,
  StepType,
  UserPromptKind,
} from '@prisma/client';

describe('OrchestratorLoopService USER_INPUT_REQUIRED gate', () => {
  it('creates prompt, blocks step, and enqueues outbox without dispatch', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
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

    const userPromptService = {
      ensureOpenPromptForStep: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
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
      userPromptService,
      outboxService,
    );

    const item = {
      id: 'ci-1',
      description: 'Confirm details with the user',
      expectedOutcome: 'Details confirmed',
      suggestedTools: ['ASK_USER'],
      requiresDesktop: false,
      executionSurface: ExecutionSurface.TEXT_ONLY,
      type: StepType.USER_INPUT_REQUIRED,
      startedAt: null,
    };

    prisma.checklistItem.findUnique.mockResolvedValueOnce(item);

    const prompt = {
      id: 'p-1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
    };

    userPromptService.ensureOpenPromptForStep.mockResolvedValueOnce(prompt);
    prisma.checklistItem.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 1 });
    outboxService.enqueueOnce.mockResolvedValueOnce({ id: 'o-1' });

    await (service as any).executeStep({ id: 'gr-1', tenantId: 't-1', phase: GoalRunPhase.EXECUTING }, item.id);

    expect(prisma.checklistItem.update).not.toHaveBeenCalled(); // Never mark IN_PROGRESS
    expect(userPromptService.ensureOpenPromptForStep).toHaveBeenCalledTimes(1);
    expect(prisma.checklistItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: item.id,
        status: {
          in: [ChecklistItemStatus.PENDING, ChecklistItemStatus.IN_PROGRESS],
        },
      },
      data: expect.objectContaining({
        status: ChecklistItemStatus.BLOCKED,
      }),
    });
    expect(prisma.goalRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'gr-1',
        phase: {
          in: [GoalRunPhase.EXECUTING, GoalRunPhase.CONTROLLING_DESKTOP],
        },
      },
      data: { phase: GoalRunPhase.WAITING_USER_INPUT },
    });
    expect(goalRunService.createActivityEvent).toHaveBeenCalledWith('gr-1', expect.objectContaining({
      eventType: 'USER_PROMPT_CREATED',
      checklistItemId: item.id,
      details: expect.objectContaining({ promptId: prompt.id }),
    }));
    expect(outboxService.enqueueOnce).toHaveBeenCalledWith({
      dedupeKey: prompt.dedupeKey,
      aggregateId: 'gr-1',
      eventType: 'user_prompt.created',
      payload: {
        promptId: prompt.id,
        goalRunId: 'gr-1',
        tenantId: 't-1',
        checklistItemId: item.id,
        kind: prompt.kind,
        stepDescription: item.description,
      },
    });

    // Ensure we never dispatch agent work for prompt steps
    expect(eventEmitter.emit).not.toHaveBeenCalledWith('workflow.node-ready', expect.anything());
  });

  it('is idempotent: second tick does not re-emit activity', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
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

    const userPromptService = {
      ensureOpenPromptForStep: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
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
      userPromptService,
      outboxService,
    );

    const item = {
      id: 'ci-1',
      description: 'Confirm details with the user',
      expectedOutcome: 'Details confirmed',
      suggestedTools: ['ASK_USER'],
      requiresDesktop: false,
      executionSurface: ExecutionSurface.TEXT_ONLY,
      type: StepType.EXECUTE, // Legacy backfill; ASK_USER is the explicit machine flag
      startedAt: null,
    };

    prisma.checklistItem.findUnique.mockResolvedValue(item);

    const prompt = {
      id: 'p-1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
    };

    userPromptService.ensureOpenPromptForStep.mockResolvedValue(prompt);
    prisma.checklistItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.goalRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await (service as any).executeStep({ id: 'gr-1', tenantId: 't-1', phase: GoalRunPhase.EXECUTING }, item.id);
    await (service as any).executeStep({ id: 'gr-1', tenantId: 't-1', phase: GoalRunPhase.EXECUTING }, item.id);

    expect(goalRunService.createActivityEvent).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(outboxService.enqueueOnce).toHaveBeenCalledTimes(2); // safe: deduped by key in DB
    expect(prisma.checklistItem.update).not.toHaveBeenCalled();
  });
});
