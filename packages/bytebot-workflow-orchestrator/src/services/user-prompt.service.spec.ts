import { UserPromptService } from './user-prompt.service';
import { UserPromptCancelReason, UserPromptKind, UserPromptStatus } from '@prisma/client';

jest.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'p-new',
}));

describe(UserPromptService.name, () => {
  it('creates an OPEN prompt on first call', async () => {
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      userPrompt: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;

    const service = new UserPromptService(prisma);

    const created = {
      id: 'p1',
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      status: UserPromptStatus.OPEN,
      dedupeKey: service.buildDedupeKey('run1', 'step1', UserPromptKind.TEXT_CLARIFICATION),
      payload: { question: 'q' },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce(null);
    prisma.userPrompt.findFirst.mockResolvedValueOnce(null);
    prisma.userPrompt.create.mockResolvedValueOnce(created);

    const result = await service.ensureOpenPromptForStep({
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      payload: { question: 'q' },
    });

    expect(result).toBe(created);
    expect(prisma.userPrompt.create).toHaveBeenCalledTimes(1);
    expect(prisma.userPrompt.updateMany).not.toHaveBeenCalled();
  });

  it('dedupes by returning existing prompt when dedupeKey exists', async () => {
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      userPrompt: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;

    const service = new UserPromptService(prisma);
    const dedupeKey = service.buildDedupeKey('run1', 'step1', UserPromptKind.TEXT_CLARIFICATION);

    const existing = {
      id: 'p1',
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      status: UserPromptStatus.OPEN,
      dedupeKey,
      payload: { question: 'q' },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce(existing);

    const result = await service.ensureOpenPromptForStep({
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step1',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      payload: { question: 'q' },
    });

    expect(result).toBe(existing);
    expect(prisma.userPrompt.findUnique).toHaveBeenCalledWith({ where: { dedupeKey } });
    expect(prisma.userPrompt.create).not.toHaveBeenCalled();
    expect(prisma.userPrompt.updateMany).not.toHaveBeenCalled();
  });

  it('supersedes an existing OPEN prompt for the run', async () => {
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
      userPrompt: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;

    const service = new UserPromptService(prisma);

    const existingOpen = {
      id: 'p-old',
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step-old',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      status: UserPromptStatus.OPEN,
      dedupeKey: 'prompt:run1:step-old:TEXT_CLARIFICATION',
      rootPromptId: null,
      revision: 2,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };

    const created = {
      id: 'p-new',
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step-new',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      status: UserPromptStatus.OPEN,
      dedupeKey: service.buildDedupeKey('run1', 'step-new', UserPromptKind.TEXT_CLARIFICATION),
      payload: { question: 'q2' },
    };

    prisma.userPrompt.findUnique.mockResolvedValueOnce(null);
    prisma.userPrompt.findFirst.mockResolvedValueOnce(existingOpen);
    prisma.userPrompt.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.userPrompt.create.mockResolvedValueOnce(created);

    const result = await service.ensureOpenPromptForStep({
      tenantId: 't1',
      goalRunId: 'run1',
      checklistItemId: 'step-new',
      kind: UserPromptKind.TEXT_CLARIFICATION,
      payload: { question: 'q2' },
    });

    expect(result).toBe(created);
    expect(prisma.userPrompt.updateMany).toHaveBeenCalledWith({
      where: { id: existingOpen.id, status: UserPromptStatus.OPEN },
      data: expect.objectContaining({
        status: UserPromptStatus.CANCELLED,
        cancelReason: UserPromptCancelReason.SUPERSEDED,
        supersededByPromptId: 'p-new',
      }),
    });
    expect(prisma.userPrompt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'p-new',
        tenantId: 't1',
        goalRunId: 'run1',
        checklistItemId: 'step-new',
        supersedesPromptId: existingOpen.id,
        rootPromptId: existingOpen.id,
        revision: existingOpen.revision + 1,
      }),
    });
  });

  it('lists prompts filtered by tenant and goalRun', async () => {
    const prisma = {
      userPrompt: {
        findMany: jest.fn(),
      },
    } as any;

    const service = new UserPromptService(prisma);

    const prompts = [
      { id: 'p1', tenantId: 't1', goalRunId: 'gr1' },
      { id: 'p2', tenantId: 't1', goalRunId: 'gr1' },
    ];
    prisma.userPrompt.findMany.mockResolvedValueOnce(prompts);

    const result = await service.listUserPrompts({ tenantId: 't1', goalRunId: 'gr1', limit: 10 });

    expect(result).toBe(prompts);
    expect(prisma.userPrompt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 't1', goalRunId: 'gr1' }),
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    );
  });
});
