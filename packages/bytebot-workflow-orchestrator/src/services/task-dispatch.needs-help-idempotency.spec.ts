import { TaskDispatchService } from './task-dispatch.service';
import { GoalRunExecutionEngine, GoalRunPhase, UserPromptKind } from '@prisma/client';

describe('TaskDispatchService NEEDS_HELP idempotency', () => {
  it('emits a single needs-help activity and then stays quiet', async () => {
    const prisma = {
      checklistItem: {
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const dbTransientService = {
      isInBackoff: jest.fn(() => false),
      getBackoffRemainingMs: jest.fn(() => 0),
      withTransientGuard: jest.fn(async (fn: any) => fn()),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const userPromptService = {
      buildDedupeKey: jest.fn((goalRunId: string, stepId: string, kind: string) => `prompt:${goalRunId}:${stepId}:${kind}`),
      ensureOpenPromptForStep: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
    } as any;

    const service = new TaskDispatchService(
      configService,
      prisma,
      dbTransientService,
      eventEmitter,
      userPromptService,
      outboxService,
    );

    // Avoid real HTTP calls
    (service as any).taskControllerClient = { delete: jest.fn() };
    // Avoid deep DB activity plumbing; focus on idempotency behavior
    (service as any).emitActivityEvent = jest.fn();

    prisma.checklistItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.userPrompt.findUnique.mockResolvedValue(null);
    prisma.goalRun.findUnique.mockResolvedValue({ phase: GoalRunPhase.EXECUTING, tenantId: 't-1' });
    prisma.goalRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    userPromptService.ensureOpenPromptForStep.mockResolvedValue({
      id: 'p-1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
    });

    const record: any = {
      idempotencyKey: 'gr-1:ci-1:1',
      taskId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      status: 'RUNNING',
      createdAt: new Date(),
      consecutiveCheckFailures: 0,
      notFoundCount: 0,
      isHeartbeatHealthy: true,
      consecutiveHeartbeatUnhealthy: 0,
    };

    const task: any = {
      id: 't-1',
      status: 'NEEDS_HELP',
      title: 'Need clarification',
      result: { question: 'Which account should I use?' },
      error: null,
    };

    await (service as any).handleTaskNeedsHelp(record, task);
    await (service as any).handleTaskNeedsHelp(record, task);

    expect(record.status).toBe('WAITING_USER');
    expect((service as any).taskControllerClient.delete).toHaveBeenCalledTimes(1);
    expect((service as any).emitActivityEvent).toHaveBeenCalledTimes(2);
    expect((service as any).emitActivityEvent).toHaveBeenCalledWith(
      record.goalRunId,
      'USER_PROMPT_CREATED',
      expect.any(String),
      expect.objectContaining({ promptId: 'p-1' }),
    );
    expect((service as any).emitActivityEvent).toHaveBeenCalledWith(
      record.goalRunId,
      'STEP_NEEDS_HELP',
      expect.any(String),
      expect.objectContaining({ checklistItemId: record.checklistItemId }),
    );
    expect(outboxService.enqueueOnce).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.phase-changed', expect.anything());
  });

  it('preserves desktop for DESKTOP_TAKEOVER and extends timeout once', async () => {
    const prisma = {
      checklistItem: {
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const dbTransientService = {
      isInBackoff: jest.fn(() => false),
      getBackoffRemainingMs: jest.fn(() => 0),
      withTransientGuard: jest.fn(async (fn: any) => fn()),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const userPromptService = {
      buildDedupeKey: jest.fn((goalRunId: string, stepId: string, kind: string) => `prompt:${goalRunId}:${stepId}:${kind}`),
      ensureOpenPromptForStep: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
    } as any;

    const service = new TaskDispatchService(
      configService,
      prisma,
      dbTransientService,
      eventEmitter,
      userPromptService,
      outboxService,
    );

    // Avoid real HTTP calls
    (service as any).taskControllerClient = { delete: jest.fn(), post: jest.fn().mockResolvedValue({}) };
    // Avoid deep DB activity plumbing; focus on idempotency behavior
    (service as any).emitActivityEvent = jest.fn();

    prisma.checklistItem.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.userPrompt.findUnique.mockResolvedValue(null);
    prisma.goalRun.findUnique.mockResolvedValue({ phase: GoalRunPhase.EXECUTING, tenantId: 't-1' });
    prisma.goalRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    userPromptService.ensureOpenPromptForStep.mockResolvedValue({
      id: 'p-1',
      kind: UserPromptKind.DESKTOP_TAKEOVER,
      dedupeKey: 'prompt:gr-1:ci-1:DESKTOP_TAKEOVER',
    });

    const record: any = {
      idempotencyKey: 'gr-1:ci-1:1',
      taskId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      status: 'RUNNING',
      createdAt: new Date(),
      consecutiveCheckFailures: 0,
      notFoundCount: 0,
      isHeartbeatHealthy: true,
      consecutiveHeartbeatUnhealthy: 0,
    };

    const task: any = {
      id: 't-1',
      status: 'NEEDS_HELP',
      title: 'User takeover required',
      result: { reason: 'MFA prompt in browser' },
      error: null,
      requiresDesktop: true,
      workspaceId: null,
    };

    await (service as any).handleTaskNeedsHelp(record, task);
    await (service as any).handleTaskNeedsHelp(record, task);

    expect(record.status).toBe('WAITING_USER');
    expect(userPromptService.ensureOpenPromptForStep).toHaveBeenCalledWith(
      expect.objectContaining({ kind: UserPromptKind.DESKTOP_TAKEOVER }),
    );
    expect((service as any).taskControllerClient.delete).not.toHaveBeenCalled();
    expect((service as any).taskControllerClient.post).toHaveBeenCalledTimes(1);
    expect((service as any).taskControllerClient.post).toHaveBeenCalledWith(
      `/api/v1/tasks/${record.taskId}/extend`,
      expect.objectContaining({ additionalMinutes: 60 }),
    );
    expect((service as any).emitActivityEvent).toHaveBeenCalledTimes(2);
    expect((service as any).emitActivityEvent).toHaveBeenCalledWith(
      record.goalRunId,
      'USER_PROMPT_CREATED',
      expect.any(String),
      expect.objectContaining({ promptId: 'p-1' }),
    );
    expect((service as any).emitActivityEvent).toHaveBeenCalledWith(
      record.goalRunId,
      'STEP_NEEDS_HELP',
      expect.any(String),
      expect.objectContaining({ checklistItemId: record.checklistItemId }),
    );
    expect(outboxService.enqueueOnce).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.phase-changed', expect.anything());
  });

  it('creates a step prompt without ChecklistItem FK for TEMPORAL_WORKFLOW runs', async () => {
    const prisma = {
      checklistItem: {
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const dbTransientService = {
      isInBackoff: jest.fn(() => false),
      getBackoffRemainingMs: jest.fn(() => 0),
      withTransientGuard: jest.fn(async (fn: any) => fn()),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const userPromptService = {
      buildDedupeKey: jest.fn((goalRunId: string, stepId: string, kind: string) => `prompt:${goalRunId}:${stepId}:${kind}`),
      ensureOpenPromptForStep: jest.fn(),
      ensureOpenPromptForStepKey: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
    } as any;

    const service = new TaskDispatchService(
      configService,
      prisma,
      dbTransientService,
      eventEmitter,
      userPromptService,
      outboxService,
    );

    // Avoid real HTTP calls
    (service as any).taskControllerClient = { delete: jest.fn() };
    // Avoid deep DB activity plumbing; focus on idempotency + Temporal FK safety
    (service as any).emitActivityEvent = jest.fn();

    prisma.goalRun.findUnique.mockResolvedValue({
      phase: GoalRunPhase.EXECUTING,
      tenantId: 't-1',
      executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
    });
    prisma.userPrompt.findUnique.mockResolvedValue(null);
    prisma.goalRun.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    userPromptService.ensureOpenPromptForStepKey.mockResolvedValue({
      id: 'p-1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      dedupeKey: 'prompt:gr-1:step-1:TEXT_CLARIFICATION',
    });

    const record: any = {
      idempotencyKey: 'gr-1:gr-1-step-1:1',
      taskId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'gr-1-step-1',
      status: 'RUNNING',
      createdAt: new Date(),
      consecutiveCheckFailures: 0,
      notFoundCount: 0,
      isHeartbeatHealthy: true,
      consecutiveHeartbeatUnhealthy: 0,
    };

    const task: any = {
      id: 't-1',
      status: 'NEEDS_HELP',
      title: 'Need clarification',
      result: { question: 'Which account should I use?' },
      error: null,
      requiresDesktop: false,
      workspaceId: null,
    };

    await (service as any).handleTaskNeedsHelp(record, task);
    await (service as any).handleTaskNeedsHelp(record, task);

    expect(record.status).toBe('WAITING_USER');
    expect(userPromptService.ensureOpenPromptForStep).not.toHaveBeenCalled();
    expect(userPromptService.ensureOpenPromptForStepKey).toHaveBeenCalledWith(
      expect.objectContaining({ goalRunId: 'gr-1', stepKey: 'step-1', kind: UserPromptKind.TEXT_CLARIFICATION }),
    );
    expect(prisma.checklistItem.updateMany).not.toHaveBeenCalled();
    expect(outboxService.enqueueOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          checklistItemId: null,
          stepKey: 'step-1',
        }),
      }),
    );
  });

  it('is restart-safe: if an OPEN prompt already exists, it does not re-emit NEEDS_HELP side effects', async () => {
    const prisma = {
      checklistItem: {
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const dbTransientService = {
      isInBackoff: jest.fn(() => false),
      getBackoffRemainingMs: jest.fn(() => 0),
      withTransientGuard: jest.fn(async (fn: any) => fn()),
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const eventEmitter = {
      emit: jest.fn(),
    } as any;

    const userPromptService = {
      buildDedupeKey: jest.fn((goalRunId: string, stepId: string, kind: string) => `prompt:${goalRunId}:${stepId}:${kind}`),
      ensureOpenPromptForStep: jest.fn(),
    } as any;

    const outboxService = {
      enqueueOnce: jest.fn(),
    } as any;

    const service = new TaskDispatchService(
      configService,
      prisma,
      dbTransientService,
      eventEmitter,
      userPromptService,
      outboxService,
    );

    (service as any).taskControllerClient = { delete: jest.fn(), post: jest.fn() };
    (service as any).emitActivityEvent = jest.fn();

    prisma.goalRun.findUnique
      .mockResolvedValueOnce({ tenantId: 't-1', executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP })
      .mockResolvedValueOnce({ phase: GoalRunPhase.WAITING_USER_INPUT });
    prisma.goalRun.updateMany.mockResolvedValue({ count: 0 });

    prisma.userPrompt.findUnique.mockResolvedValue({
      id: 'p-1',
      status: 'OPEN',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
    });

    prisma.checklistItem.updateMany.mockResolvedValue({ count: 0 });
    prisma.checklistItem.findUnique.mockResolvedValue({
      status: 'BLOCKED',
      blockedByPromptId: 'p-1',
    });

    const record: any = {
      idempotencyKey: 'gr-1:ci-1:1',
      taskId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      status: 'RUNNING',
      createdAt: new Date(),
      consecutiveCheckFailures: 0,
      notFoundCount: 0,
      isHeartbeatHealthy: true,
      consecutiveHeartbeatUnhealthy: 0,
    };

    const task: any = {
      id: 't-1',
      status: 'NEEDS_HELP',
      title: 'Need clarification',
      result: { question: 'Which account should I use?' },
      error: null,
    };

    await (service as any).handleTaskNeedsHelp(record, task);

    expect(record.status).toBe('WAITING_USER');
    expect(userPromptService.ensureOpenPromptForStep).not.toHaveBeenCalled();
    expect(outboxService.enqueueOnce).toHaveBeenCalledTimes(1);
    expect((service as any).emitActivityEvent).not.toHaveBeenCalled();
    expect((service as any).taskControllerClient.delete).not.toHaveBeenCalled();
    expect((service as any).taskControllerClient.post).not.toHaveBeenCalled();
  });
});
