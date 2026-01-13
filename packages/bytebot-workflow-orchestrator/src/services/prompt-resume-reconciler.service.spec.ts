import { PromptResumeReconcilerService } from './prompt-resume-reconciler.service';

describe(PromptResumeReconcilerService.name, () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enqueues canonical resume outbox when missing', async () => {
    const configService = { get: jest.fn((_k: string, fallback: string) => fallback) } as any;
    const prisma = { $queryRaw: jest.fn() } as any;
    const outboxService = { enqueueOnce: jest.fn() } as any;
    const leaderElection = { isLeader: true } as any;
    const resumeOutboxEnqueuedTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;

    const service = new PromptResumeReconcilerService(
      configService,
      prisma,
      outboxService,
      leaderElection,
      resumeOutboxEnqueuedTotal,
    );

    prisma.$queryRaw.mockResolvedValueOnce([
      { promptId: 'p-1', goalRunId: 'gr-1', tenantId: 't-1', outboxId: null, outboxProcessedAt: null },
    ]);

    await service.tick();

    expect(outboxService.enqueueOnce).toHaveBeenCalledWith({
      dedupeKey: 'user_prompt.resume:p-1',
      aggregateId: 'gr-1',
      eventType: 'user_prompt.resume',
      payload: expect.objectContaining({
        promptId: 'p-1',
        goalRunId: 'gr-1',
        tenantId: 't-1',
        updateId: 'user_prompt.resume:p-1',
      }),
    });
    expect(resumeOutboxEnqueuedTotal.labels).toHaveBeenCalledWith('reconciler');
  });

  it('re-arms the canonical resume outbox when it was processed and ack is still missing', async () => {
    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === 'PROMPT_RESUME_RECONCILER_BUCKET_MINUTES') return '5';
        return fallback;
      }),
    } as any;
    const prisma = { $queryRaw: jest.fn(), outbox: { updateMany: jest.fn() } } as any;
    const outboxService = { enqueueOnce: jest.fn() } as any;
    const leaderElection = { isLeader: true } as any;
    const resumeOutboxEnqueuedTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;

    const service = new PromptResumeReconcilerService(
      configService,
      prisma,
      outboxService,
      leaderElection,
      resumeOutboxEnqueuedTotal,
    );

    prisma.$queryRaw.mockResolvedValueOnce([
      { promptId: 'p-2', goalRunId: 'gr-2', tenantId: 't-2', outboxId: 'o-xyz', outboxProcessedAt: new Date() },
    ]);

    await service.tick();

    expect(outboxService.enqueueOnce).not.toHaveBeenCalled();
    expect(prisma.outbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'o-xyz', processedAt: { not: null } },
      data: expect.objectContaining({
        processedAt: null,
        retryCount: 0,
        nextAttemptAt: expect.any(Date),
      }),
    });
    expect(resumeOutboxEnqueuedTotal.labels).toHaveBeenCalledWith('reconciler_rearm');
  });
});
