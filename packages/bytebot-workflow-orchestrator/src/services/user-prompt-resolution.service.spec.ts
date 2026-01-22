import { UserPromptResolutionService } from './user-prompt-resolution.service';
import {
  ActorType,
  ChecklistItemStatus,
  GoalRunPhase,
  GoalSpecStatus,
  StepType,
  UserPromptKind,
  UserPromptScope,
  UserPromptStatus,
} from '@prisma/client';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';

describe(UserPromptResolutionService.name, () => {
  it('resolves an OPEN prompt once and emits outbox + phase change', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      userPrompt: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      userPromptResolution: {
        create: jest.fn(),
      },
      checklistItem: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      outbox: {
        create: jest.fn(),
      },
    };

    tx.$queryRaw.mockResolvedValue([{ id: 'p-1' }]);
    tx.userPrompt.findUnique
      .mockResolvedValueOnce({
        id: 'p-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: 'ci-1',
        goalSpecId: null,
        status: UserPromptStatus.OPEN,
        kind: UserPromptKind.TEXT_CLARIFICATION,
        scope: UserPromptScope.STEP,
        jsonSchema: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'p-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: 'ci-1',
        goalSpecId: null,
        status: UserPromptStatus.RESOLVED,
        kind: UserPromptKind.TEXT_CLARIFICATION,
        scope: UserPromptScope.STEP,
        jsonSchema: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
    tx.userPromptResolution.create.mockResolvedValue({ id: 'pr-1' });
    tx.userPrompt.updateMany.mockResolvedValue({ count: 1 });
    tx.checklistItem.findUnique.mockResolvedValue({
      type: StepType.USER_INPUT_REQUIRED,
      description: 'Confirm details',
    });
    tx.checklistItem.updateMany.mockResolvedValue({ count: 1 });
    tx.goalRun.findUnique.mockResolvedValue({
      phase: GoalRunPhase.WAITING_USER_INPUT,
      tenantId: 't-1',
    });
    tx.goalRun.updateMany.mockResolvedValue({ count: 1 });
    tx.outbox.create.mockResolvedValue({ id: 'o-1' });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: null,
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.TEXT_CLARIFICATION,
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-1' });

    const eventEmitter: any = { emit: jest.fn() };
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => s),
      validate: jest.fn(() => ({ valid: true, violations: [], missingFields: [] })),
    };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    const result = await service.resolvePrompt({
      promptId: 'p-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { answer: 'yes' },
      requestId: 'req-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(result).toEqual({
      promptId: 'p-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      didResolve: true,
      promptStatus: UserPromptStatus.RESOLVED,
      promptKind: UserPromptKind.TEXT_CLARIFICATION,
    });

    expect(tx.outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: 'user_prompt.resolved:p-1',
          eventType: 'user_prompt.resolved',
        }),
      }),
    );
    expect(tx.outbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dedupeKey: 'user_prompt.resume:p-1',
          eventType: 'user_prompt.resume',
        }),
      }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.phase-changed', expect.anything());
    expect(userPromptTimeToResolveSeconds.labels).toHaveBeenCalledWith(UserPromptKind.TEXT_CLARIFICATION);
    expect(promptResolvedTotal.labels).toHaveBeenCalledWith(ActorType.HUMAN, UserPromptKind.TEXT_CLARIFICATION);
    expect(resumeOutboxEnqueuedTotal.labels).toHaveBeenCalledWith('resolution');
  });

  it('is idempotent: resolving an already-RESOLVED prompt is a no-op (no outbox)', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      userPrompt: {
        findUnique: jest.fn(),
      },
      outbox: {
        create: jest.fn(),
      },
    };

    tx.$queryRaw.mockResolvedValue([{ id: 'p-1' }]);
    tx.userPrompt.findUnique.mockResolvedValue({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      goalSpecId: null,
      status: UserPromptStatus.RESOLVED,
      kind: UserPromptKind.TEXT_CLARIFICATION,
      scope: UserPromptScope.STEP,
      jsonSchema: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: null,
      status: UserPromptStatus.RESOLVED,
      kind: UserPromptKind.TEXT_CLARIFICATION,
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-1' });

    const eventEmitter: any = { emit: jest.fn() };
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => s),
      validate: jest.fn(() => ({ valid: true, violations: [], missingFields: [] })),
    };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    const result = await service.resolvePrompt({
      promptId: 'p-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { answer: 'yes' },
    });

    expect(result.didResolve).toBe(false);
    expect(tx.outbox.create).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('resolving a GOAL_INTAKE prompt returns run to INITIALIZING (so planning can restart)', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      userPrompt: { findUnique: jest.fn(), updateMany: jest.fn() },
      userPromptResolution: { create: jest.fn() },
      goalSpec: { findUnique: jest.fn(), update: jest.fn() },
      goalRun: { findUnique: jest.fn(), updateMany: jest.fn() },
      outbox: { create: jest.fn() },
    };

    tx.$queryRaw.mockResolvedValue([{ id: 'p-gi-1' }]);
    tx.userPrompt.findUnique
      .mockResolvedValueOnce({
        id: 'p-gi-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: null,
        goalSpecId: 'gs-1',
        status: UserPromptStatus.OPEN,
        kind: UserPromptKind.GOAL_INTAKE,
        scope: UserPromptScope.RUN,
        jsonSchema: {
          type: 'object',
          properties: { notes: { type: 'string', minLength: 1 } },
          required: ['notes'],
        },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'p-gi-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: null,
        goalSpecId: 'gs-1',
        status: UserPromptStatus.RESOLVED,
        kind: UserPromptKind.GOAL_INTAKE,
        scope: UserPromptScope.RUN,
        jsonSchema: {
          type: 'object',
          properties: { notes: { type: 'string', minLength: 1 } },
          required: ['notes'],
        },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

    tx.goalSpec.findUnique.mockResolvedValue({ values: {}, status: GoalSpecStatus.INCOMPLETE });
    tx.goalSpec.update.mockResolvedValue({ id: 'gs-1' });
    tx.userPromptResolution.create.mockResolvedValue({ id: 'pr-gi-1' });
    tx.userPrompt.updateMany.mockResolvedValue({ count: 1 });
    tx.goalRun.findUnique.mockResolvedValue({ phase: GoalRunPhase.WAITING_USER_INPUT, tenantId: 't-1' });
    tx.goalRun.updateMany.mockResolvedValue({ count: 1 });
    tx.outbox.create.mockResolvedValue({ id: 'o-gi-1' });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-gi-1',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce({
      jsonSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'string' } } },
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-gi-1' });

    const eventEmitter: any = { emit: jest.fn() };
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => ({ ...s, required: [] })),
      validate: jest.fn(() => ({ valid: true, violations: [], missingFields: [] })),
    };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    const result = await service.resolvePrompt({
      promptId: 'p-gi-1',
      tenantId: 't-1',
      actor: { type: ActorType.HUMAN, id: 'u-1' },
      answers: { notes: 'Use account X, target URL Y' },
    });

    expect(result).toEqual({
      promptId: 'p-gi-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      didResolve: true,
      promptStatus: UserPromptStatus.RESOLVED,
      promptKind: UserPromptKind.GOAL_INTAKE,
    });

    expect(tx.goalRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phase: GoalRunPhase.INITIALIZING }),
      }),
    );

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'goal-run.phase-changed',
      expect.objectContaining({ newPhase: GoalRunPhase.INITIALIZING }),
    );

    expect(goalIntakeCompletedTotal.inc).toHaveBeenCalledTimes(1);
  });

  it('records an invalid attempt and does not resolve the prompt (schema validation failure)', async () => {
    const prisma: any = {
      $transaction: jest.fn(),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-gi-2',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce({
      jsonSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'string', minLength: 1 } } },
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-invalid' });

    const eventEmitter: any = { emit: jest.fn() };
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => s),
      validate: jest.fn(() => ({ valid: true, violations: [], missingFields: [] })),
    };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    await expect(
      service.resolvePrompt({
        promptId: 'p-gi-2',
        tenantId: 't-1',
        actor: { type: ActorType.HUMAN, id: 'u-1' },
        answers: {}, // missing required "notes"
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Schema validation failed',
      }),
    });

    expect(prisma.userPromptAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promptId: 'p-gi-2',
          isValid: false,
          errorCode: 'SCHEMA_VALIDATION_FAILED',
        }),
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects schema-invalid patch answers (jsonSchema snapshot) without resolving', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      userPrompt: { findUnique: jest.fn(), updateMany: jest.fn() },
      userPromptResolution: { create: jest.fn() },
      goalSpec: { findUnique: jest.fn(), update: jest.fn() },
      goalRun: { findUnique: jest.fn(), updateMany: jest.fn() },
      outbox: { create: jest.fn() },
      checklistItem: { findUnique: jest.fn(), updateMany: jest.fn() },
    };

    tx.$queryRaw.mockResolvedValue([{ id: 'p-gi-3' }]);
    tx.userPrompt.findUnique.mockResolvedValue({
      id: 'p-gi-3',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
      scope: UserPromptScope.RUN,
      jsonSchema: { type: 'object', properties: { notes: { type: 'string', minLength: 1 } }, required: ['notes'] },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-gi-3',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
    });
    prisma.goalSpec.findUnique.mockResolvedValueOnce({
      jsonSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'string' } } },
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-gi-3' });

    const eventEmitter: any = { emit: jest.fn() };
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => ({ ...s, required: [] })),
      validate: jest.fn(() => ({ valid: false, violations: [{ keyword: 'minLength' }], missingFields: [] })),
    };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    await expect(
      service.resolvePrompt({
        promptId: 'p-gi-3',
        tenantId: 't-1',
        actor: { type: ActorType.HUMAN, id: 'u-1' },
        answers: { notes: '' }, // invalid (minLength)
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(tx.userPromptResolution.create).not.toHaveBeenCalled();
    expect(tx.userPrompt.updateMany).not.toHaveBeenCalled();
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });

  it('schema-valid patch but incomplete after apply keeps prompt OPEN and emits no outbox', async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      userPrompt: { findUnique: jest.fn(), updateMany: jest.fn() },
      userPromptResolution: { create: jest.fn() },
      goalSpec: { findUnique: jest.fn(), update: jest.fn() },
      goalRun: { findUnique: jest.fn(), updateMany: jest.fn() },
      outbox: { create: jest.fn() },
      checklistItem: { findUnique: jest.fn(), updateMany: jest.fn() },
    };

    tx.$queryRaw.mockResolvedValue([{ id: 'p-gi-4' }]);
    tx.userPrompt.findUnique.mockResolvedValue({
      id: 'p-gi-4',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      checklistItemId: null,
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
      scope: UserPromptScope.RUN,
      jsonSchema: {
        type: 'object',
        properties: { notes: { type: 'string', minLength: 1 }, targetUrl: { type: 'string', minLength: 1 } },
        required: ['notes', 'targetUrl'],
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    tx.goalSpec.findUnique.mockResolvedValue({ values: {}, status: GoalSpecStatus.INCOMPLETE });
    tx.goalSpec.update.mockResolvedValue({ id: 'gs-1' });
    tx.goalRun.findUnique.mockResolvedValue({ phase: GoalRunPhase.WAITING_USER_INPUT, tenantId: 't-1' });

    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      userPrompt: { findUnique: jest.fn() },
      goalRun: { findUnique: jest.fn() },
      goalSpec: { findUnique: jest.fn() },
      userPromptAttempt: { create: jest.fn(), findFirst: jest.fn() },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce({
      id: 'p-gi-4',
      tenantId: 't-1',
      goalRunId: 'gr-1',
      goalSpecId: 'gs-1',
      status: UserPromptStatus.OPEN,
      kind: UserPromptKind.GOAL_INTAKE,
    });
    // Preflight schema only requires notes; full snapshot requires notes+targetUrl.
    prisma.goalSpec.findUnique.mockResolvedValueOnce({
      jsonSchema: { type: 'object', required: ['notes'], properties: { notes: { type: 'string' } } },
    });
    prisma.userPromptAttempt.create.mockResolvedValueOnce({ id: 'pa-gi-4' });

    // Patch validate passes; full validate fails with missing required.
    const jsonSchemaValidator: any = {
      makePatchSchema: jest.fn((s: any) => ({ ...s, required: [] })),
      validate: jest
        .fn()
        .mockReturnValueOnce({ valid: true, violations: [], missingFields: [] })
        .mockReturnValueOnce({
          valid: false,
          violations: [{ keyword: 'required', params: { missingProperty: 'targetUrl' } }],
          missingFields: ['targetUrl'],
        }),
    };

    const eventEmitter: any = { emit: jest.fn() };
    const userPromptTimeToResolveSeconds: any = { labels: jest.fn(() => ({ observe: jest.fn() })) };
    const promptResolvedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const goalIntakeCompletedTotal: any = { inc: jest.fn() };
    const resumeOutboxEnqueuedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const validationFailTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const unauthorizedTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };
    const incompleteAfterApplyTotal: any = { labels: jest.fn(() => ({ inc: jest.fn() })) };

    const service = new UserPromptResolutionService(
      prisma,
      eventEmitter,
      jsonSchemaValidator,
      userPromptTimeToResolveSeconds,
      promptResolvedTotal,
      goalIntakeCompletedTotal,
      resumeOutboxEnqueuedTotal,
      validationFailTotal,
      unauthorizedTotal,
      incompleteAfterApplyTotal,
      undefined,
    );

    await expect(
      service.resolvePrompt({
        promptId: 'p-gi-4',
        tenantId: 't-1',
        actor: { type: ActorType.HUMAN, id: 'u-1' },
        answers: { notes: 'ok' }, // patch-valid, but incomplete after merge
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.goalSpec.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: GoalSpecStatus.INCOMPLETE }),
      }),
    );
    expect(tx.userPromptResolution.create).not.toHaveBeenCalled();
    expect(tx.userPrompt.updateMany).not.toHaveBeenCalled();
    expect(tx.outbox.create).not.toHaveBeenCalled();
  });
});
