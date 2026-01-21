import { OrchestratorLoopService } from './orchestrator-loop.service';
import {
  ChecklistItemStatus,
  ExecutionSurface,
  GoalSpecStatus,
  GoalRunPhase,
  GoalRunWaitReason,
  StepType,
  UserPromptKind,
} from '@prisma/client';

describe('OrchestratorLoopService USER_INPUT_REQUIRED gate', () => {
  it('creates DESKTOP_TAKEOVER prompt, blocks step, and enqueues outbox without dispatch', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
      },
      goalRun: {
        updateMany: jest.fn(),
      },
    } as any;

    const goalRunService = {
      createActivityEvent: jest.fn(),
    } as any;

    const goalIntakeService = {
      ensureGoalSpecReadyForPlanning: jest.fn(),
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
      goalIntakeService,
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
      requiresDesktop: true,
      executionSurface: ExecutionSurface.DESKTOP,
      type: StepType.USER_INPUT_REQUIRED,
      startedAt: null,
      blockedByPromptId: null,
    };

    prisma.checklistItem.findUnique.mockResolvedValueOnce(item);

    const prompt = {
      id: 'p-1',
      kind: UserPromptKind.DESKTOP_TAKEOVER,
      dedupeKey: 'prompt:gr-1:ci-1:DESKTOP_TAKEOVER',
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
      data: expect.objectContaining({
        phase: GoalRunPhase.WAITING_USER_INPUT,
        waitReason: GoalRunWaitReason.USER_INPUT,
      }),
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
    expect(goalIntakeService.ensureGoalSpecReadyForPlanning).not.toHaveBeenCalled();
  });

  it('auto-resolves TEXT_ONLY USER_INPUT_REQUIRED when GoalSpec is COMPLETE', async () => {
    const prisma = {
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
      },
      userPrompt: {
        updateMany: jest.fn(),
      },
      goalRun: {
        updateMany: jest.fn(),
      },
    } as any;

    const goalRunService = {
      createActivityEvent: jest.fn(),
    } as any;

    const goalIntakeService = {
      ensureGoalSpecReadyForPlanning: jest.fn(),
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
      goalIntakeService,
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
      description: 'Ask the user which flight site to use',
      expectedOutcome: 'Site chosen',
      suggestedTools: ['ASK_USER'],
      requiresDesktop: false,
      executionSurface: ExecutionSurface.TEXT_ONLY,
      type: StepType.USER_INPUT_REQUIRED,
      startedAt: null,
      blockedByPromptId: null,
    };

    prisma.checklistItem.findUnique.mockResolvedValueOnce(item);
    prisma.goalSpec.findUnique.mockResolvedValueOnce({ status: GoalSpecStatus.COMPLETE });
    prisma.checklistItem.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await (service as any).executeStep({ id: 'gr-1', tenantId: 't-1', phase: GoalRunPhase.EXECUTING }, item.id);

    expect(userPromptService.ensureOpenPromptForStep).not.toHaveBeenCalled();
    expect(outboxService.enqueueOnce).not.toHaveBeenCalled();
    expect(goalIntakeService.ensureGoalSpecReadyForPlanning).not.toHaveBeenCalled();

    expect(prisma.checklistItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: item.id,
        status: {
          in: [ChecklistItemStatus.PENDING, ChecklistItemStatus.IN_PROGRESS, ChecklistItemStatus.BLOCKED],
        },
      },
      data: expect.objectContaining({
        status: ChecklistItemStatus.COMPLETED,
      }),
    });

    expect(goalRunService.createActivityEvent).toHaveBeenCalledWith('gr-1', expect.objectContaining({
      eventType: 'STEP_AUTO_RESOLVED',
      checklistItemId: item.id,
    }));
  });
});
