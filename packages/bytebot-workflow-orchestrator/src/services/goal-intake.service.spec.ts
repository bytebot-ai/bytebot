import { GoalIntakeService } from './goal-intake.service';
import { GoalRunPhase, GoalSpecStatus, UserPromptKind } from '@prisma/client';

describe('GoalIntakeService GoalSpec gate before planning', () => {
  it('returns ready=true and creates a minimal COMPLETE GoalSpec when none exists', async () => {
    const prisma = {
      goalRun: {
        findUnique: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    prisma.goalRun.findUnique.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      phase: GoalRunPhase.INITIALIZING,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce(null);
    prisma.goalSpec.create.mockResolvedValueOnce({
      id: 'gs-1',
      status: GoalSpecStatus.COMPLETE,
      schemaId: 'goal_intake.v1',
      schemaVersion: 1,
      jsonSchema: {},
      uiSchema: {},
      values: {},
    });

    const userPromptService = { ensureOpenGoalSpecPrompt: jest.fn() } as any;
    const outboxService = { enqueueOnce: jest.fn() } as any;
    const goalRunService = { createActivityEvent: jest.fn() } as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const configService = { get: jest.fn(() => '') } as any;
    const goalIntakeStartedTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;

    const service = new GoalIntakeService(
      prisma,
      userPromptService,
      outboxService,
      goalRunService,
      eventEmitter,
      configService,
      goalIntakeStartedTotal,
    );

    const result = await service.ensureGoalSpecReadyForPlanning({ goalRunId: 'gr-1', tenantId: 't-1' });

    expect(result).toEqual({ ready: true, goalSpecId: 'gs-1' });
    expect(userPromptService.ensureOpenGoalSpecPrompt).not.toHaveBeenCalled();
    expect(outboxService.enqueueOnce).not.toHaveBeenCalled();
    expect(goalRunService.createActivityEvent).not.toHaveBeenCalled();
  });

  it('creates/ensures an OPEN GOAL_INTAKE prompt and moves run to WAITING_USER_INPUT when GoalSpec is INCOMPLETE', async () => {
    const prisma = {
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
      },
    } as any;

    prisma.goalRun.findUnique.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      phase: GoalRunPhase.INITIALIZING,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce({
      id: 'gs-1',
      status: GoalSpecStatus.INCOMPLETE,
      schemaId: 'goal_intake.v1',
      schemaVersion: 1,
      jsonSchema: { title: 'Goal Intake' },
      uiSchema: { notes: { 'ui:widget': 'textarea' } },
      values: {},
    });

    const prompt = {
      id: 'p-1',
      kind: UserPromptKind.GOAL_INTAKE,
      dedupeKey: 'prompt:gr-1:goalSpec:gs-1:GOAL_INTAKE',
    };

    const userPromptService = {
      ensureOpenGoalSpecPrompt: jest.fn().mockResolvedValueOnce(prompt),
    } as any;
    const outboxService = { enqueueOnce: jest.fn() } as any;
    const goalRunService = { createActivityEvent: jest.fn() } as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const configService = { get: jest.fn(() => '') } as any;
    const goalIntakeStartedTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;

    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new GoalIntakeService(
      prisma,
      userPromptService,
      outboxService,
      goalRunService,
      eventEmitter,
      configService,
      goalIntakeStartedTotal,
    );

    const result = await service.ensureGoalSpecReadyForPlanning({ goalRunId: 'gr-1', tenantId: 't-1' });

    expect(result).toEqual({ ready: false, goalSpecId: 'gs-1', promptId: 'p-1' });
    expect(goalIntakeStartedTotal.labels).toHaveBeenCalledWith('gate');
    expect(userPromptService.ensureOpenGoalSpecPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't-1',
        goalRunId: 'gr-1',
        goalSpecId: 'gs-1',
        kind: UserPromptKind.GOAL_INTAKE,
      }),
    );
    expect(prisma.goalRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'gr-1',
        phase: { in: [GoalRunPhase.INITIALIZING, GoalRunPhase.PLANNING, GoalRunPhase.EXECUTING, GoalRunPhase.REPLANNING] },
      },
      data: { phase: GoalRunPhase.WAITING_USER_INPUT },
    });
    expect(goalRunService.createActivityEvent).toHaveBeenCalledTimes(1);
    expect(outboxService.enqueueOnce).toHaveBeenCalledWith({
      dedupeKey: prompt.dedupeKey,
      aggregateId: 'gr-1',
      eventType: 'user_prompt.created',
      payload: expect.objectContaining({
        promptId: 'p-1',
        goalRunId: 'gr-1',
        tenantId: 't-1',
        goalSpecId: 'gs-1',
        kind: UserPromptKind.GOAL_INTAKE,
      }),
    });
  });

  it('creates a default INCOMPLETE GoalSpec when GOAL_INTAKE_FORCE_TENANTS includes the tenant (so planning blocks before first plan)', async () => {
    const prisma = {
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalSpec: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    prisma.goalRun.findUnique.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      phase: GoalRunPhase.INITIALIZING,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce(null);
    prisma.goalSpec.create.mockResolvedValueOnce({
      id: 'gs-1',
      status: GoalSpecStatus.INCOMPLETE,
      schemaId: 'goal_intake.v1',
      schemaVersion: 1,
      jsonSchema: { title: 'Goal Intake' },
      uiSchema: { notes: { 'ui:widget': 'textarea' } },
      values: {},
    });

    const prompt = {
      id: 'p-1',
      kind: UserPromptKind.GOAL_INTAKE,
      dedupeKey: 'prompt:gr-1:goalSpec:gs-1:GOAL_INTAKE',
    };

    const userPromptService = {
      ensureOpenGoalSpecPrompt: jest.fn().mockResolvedValueOnce(prompt),
    } as any;
    const outboxService = { enqueueOnce: jest.fn() } as any;
    const goalRunService = { createActivityEvent: jest.fn() } as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const configService = { get: jest.fn(() => 't-1') } as any;
    const goalIntakeStartedTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;

    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new GoalIntakeService(
      prisma,
      userPromptService,
      outboxService,
      goalRunService,
      eventEmitter,
      configService,
      goalIntakeStartedTotal,
    );

    const result = await service.ensureGoalSpecReadyForPlanning({ goalRunId: 'gr-1', tenantId: 't-1' });

    expect(result).toEqual({ ready: false, goalSpecId: 'gs-1', promptId: 'p-1' });
    expect(prisma.goalSpec.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          goalRunId: 'gr-1',
          tenantId: 't-1',
          status: GoalSpecStatus.INCOMPLETE,
        }),
      }),
    );
    expect(outboxService.enqueueOnce).toHaveBeenCalledWith({
      dedupeKey: prompt.dedupeKey,
      aggregateId: 'gr-1',
      eventType: 'user_prompt.created',
      payload: expect.objectContaining({
        promptId: 'p-1',
        goalRunId: 'gr-1',
        tenantId: 't-1',
        goalSpecId: 'gs-1',
        kind: UserPromptKind.GOAL_INTAKE,
      }),
    });
  });
});
