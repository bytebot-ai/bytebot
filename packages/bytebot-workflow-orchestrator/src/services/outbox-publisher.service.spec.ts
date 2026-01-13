import { OutboxPublisherService } from './outbox-publisher.service';
import { SlackEventType } from './slack-notification.service';
import { GoalRunExecutionEngine } from '@prisma/client';

describe(OutboxPublisherService.name, () => {
  it('publishes pending user-prompt outbox rows and marks processed', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const leaderElection = { isLeader: true } as any;

    const slack = {
      sendUserPromptNotification: jest.fn().mockResolvedValue([]),
    } as any;

    const teams = {
      sendUserPromptNotification: jest.fn().mockResolvedValue([]),
    } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      undefined,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
      aggregateId: 'gr-1',
      eventType: SlackEventType.USER_PROMPT_CREATED,
      payload: {
        promptId: 'p-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: 'ci-1',
        kind: 'TEXT_CLARIFICATION',
        stepDescription: 'Confirm details',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(slack.sendUserPromptNotification).toHaveBeenCalledWith(
      SlackEventType.USER_PROMPT_CREATED,
      expect.objectContaining({
        tenantId: 't-1',
        promptId: 'p-1',
      }),
      { eventId: row.dedupeKey },
    );
    expect(teams.sendUserPromptNotification).toHaveBeenCalledTimes(1);

    expect(prisma.outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1', processedAt: null },
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    );
  });

  it('resolves tenantId from GoalRun when missing from payload', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const leaderElection = { isLeader: true } as any;

    const slack = {
      sendUserPromptNotification: jest.fn().mockResolvedValue([]),
    } as any;

    const teams = {
      sendUserPromptNotification: jest.fn().mockResolvedValue([]),
    } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      undefined,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
      aggregateId: 'gr-1',
      eventType: SlackEventType.USER_PROMPT_CREATED,
      payload: {
        promptId: 'p-1',
        tenantId: null,
        goalRunId: 'gr-1',
        checklistItemId: 'ci-1',
        kind: 'TEXT_CLARIFICATION',
        stepDescription: 'Confirm details',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.goalRun.findUnique.mockResolvedValueOnce({ tenantId: 't-1' });
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(prisma.goalRun.findUnique).toHaveBeenCalledWith({
      where: { id: 'gr-1' },
      select: { tenantId: true },
    });
    expect(slack.sendUserPromptNotification).toHaveBeenCalledWith(
      SlackEventType.USER_PROMPT_CREATED,
      expect.objectContaining({
        tenantId: 't-1',
      }),
      { eventId: row.dedupeKey },
    );
  });

  it('updates retry_count and gives up when max retries exceeded', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === 'OUTBOX_PUBLISHER_MAX_RETRIES') return '1';
        if (key === 'OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS') return '1';
        if (key === 'OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS') return '1';
        return fallback;
      }),
    } as any;

    const leaderElection = { isLeader: true } as any;

    const slack = {
      sendUserPromptNotification: jest.fn().mockRejectedValue(new Error('slack down')),
    } as any;

    const teams = {
      sendUserPromptNotification: jest.fn(),
    } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      undefined,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'prompt:gr-1:ci-1:TEXT_CLARIFICATION',
      aggregateId: 'gr-1',
      eventType: SlackEventType.USER_PROMPT_CREATED,
      payload: {
        promptId: 'p-1',
        tenantId: 't-1',
        goalRunId: 'gr-1',
        checklistItemId: 'ci-1',
        kind: 'TEXT_CLARIFICATION',
        stepDescription: 'Confirm details',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(prisma.outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1', processedAt: null },
        data: expect.objectContaining({
          retryCount: 1,
          processedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('acks resume as skipped when Temporal is disabled (prevents reconciler churn)', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      userPromptResolution: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const leaderElection = { isLeader: true } as any;
    const slack = { sendUserPromptNotification: jest.fn() } as any;
    const teams = { sendUserPromptNotification: jest.fn() } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      undefined,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'user_prompt.resume:p-1',
      aggregateId: 'gr-1',
      eventType: 'user_prompt.resume',
      payload: {
        promptId: 'p-1',
        goalRunId: 'gr-1',
        updateId: 'user_prompt.resume:p-1',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.goalRun.findUnique.mockResolvedValueOnce({ executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP });
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(prisma.userPromptResolution.updateMany).toHaveBeenCalledWith({
      where: { promptId: 'p-1', resumeAcknowledgedAt: null },
      data: expect.objectContaining({
        resumeAcknowledgedAt: expect.any(Date),
        resumeAck: expect.objectContaining({
          skipped: true,
          skipReason: 'LEGACY_ENGINE',
          executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
          updateId: 'user_prompt.resume:p-1',
        }),
      }),
    });

    expect(prisma.userPromptResolution.findUnique).not.toHaveBeenCalled();
    expect(resumeUpdateSuccessTotal.inc).not.toHaveBeenCalled();
    expect(resumeUpdateFailedTotal.inc).not.toHaveBeenCalled();
  });

  it('acks resume delivery after Temporal Update succeeds', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      userPromptResolution: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    } as any;

    const leaderElection = { isLeader: true } as any;

    const slack = {
      sendUserPromptNotification: jest.fn(),
    } as any;

    const teams = {
      sendUserPromptNotification: jest.fn(),
    } as any;

    const temporalWorkflowService = {
      isEnabled: jest.fn(() => true),
      resumeFromUserPrompt: jest.fn().mockResolvedValue({ didResume: true }),
    } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      temporalWorkflowService,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'user_prompt.resume:p-1',
      aggregateId: 'gr-1',
      eventType: 'user_prompt.resume',
      payload: {
        promptId: 'p-1',
        goalRunId: 'gr-1',
        updateId: 'user_prompt.resume:p-1',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.goalRun.findUnique.mockResolvedValueOnce({ executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW });
    prisma.userPromptResolution.findUnique.mockResolvedValueOnce({ answers: { foo: 'bar' } });
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(temporalWorkflowService.resumeFromUserPrompt).toHaveBeenCalledWith(
      'gr-1',
      { promptId: 'p-1', answers: { foo: 'bar' } },
      { updateId: 'user_prompt.resume:p-1' },
    );

    expect(prisma.userPromptResolution.updateMany).toHaveBeenCalledWith({
      where: { promptId: 'p-1', resumeAcknowledgedAt: null },
      data: expect.objectContaining({
        resumeAcknowledgedAt: expect.any(Date),
        resumeAck: expect.objectContaining({
          didResume: true,
          updateId: 'user_prompt.resume:p-1',
          executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
          outboxRowId: 'o-1',
          outboxDedupeKey: 'user_prompt.resume:p-1',
        }),
      }),
    });
    expect(resumeUpdateSuccessTotal.inc).toHaveBeenCalledTimes(1);
    expect(resumeUpdateFailedTotal.inc).not.toHaveBeenCalled();
  });

  it('Scenario E: Temporal outage leaves resume row pending, then succeeds on retry', async () => {
    const tx = { $queryRaw: jest.fn() } as any;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      outbox: {
        updateMany: jest.fn(),
      },
      userPromptResolution: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      userPrompt: {
        findUnique: jest.fn(),
      },
      goalRun: {
        findUnique: jest.fn(),
      },
    } as any;

    const outboxPendingTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const outboxOldestPendingAgeSeconds = { set: jest.fn() } as any;
    const outboxPublishAttemptsTotal = { labels: jest.fn(() => ({ inc: jest.fn() })) } as any;
    const userPromptsOpenTotal = { reset: jest.fn(), labels: jest.fn(() => ({ set: jest.fn() })) } as any;
    const resumeUpdateSuccessTotal = { inc: jest.fn() } as any;
    const resumeUpdateFailedTotal = { inc: jest.fn() } as any;

    const configService = {
      get: jest.fn((key: string, fallback: string) => {
        if (key === 'OUTBOX_PUBLISHER_MAX_RETRIES') return '20';
        if (key === 'OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS') return '1';
        if (key === 'OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS') return '1';
        return fallback;
      }),
    } as any;

    const leaderElection = { isLeader: true } as any;
    const slack = { sendUserPromptNotification: jest.fn() } as any;
    const teams = { sendUserPromptNotification: jest.fn() } as any;

    const temporalWorkflowService = {
      isEnabled: jest.fn(() => true),
      resumeFromUserPrompt: jest
        .fn()
        .mockRejectedValueOnce(new Error('Temporal unavailable'))
        .mockResolvedValueOnce({ didResume: true }),
    } as any;

    const service = new OutboxPublisherService(
      configService,
      prisma,
      leaderElection,
      slack,
      teams,
      outboxPendingTotal,
      outboxOldestPendingAgeSeconds,
      outboxPublishAttemptsTotal,
      userPromptsOpenTotal,
      resumeUpdateSuccessTotal,
      resumeUpdateFailedTotal,
      temporalWorkflowService,
    );

    const row = {
      id: 'o-1',
      dedupeKey: 'user_prompt.resume:p-1',
      aggregateId: 'gr-1',
      eventType: 'user_prompt.resume',
      payload: {
        promptId: 'p-1',
        goalRunId: 'gr-1',
        updateId: 'user_prompt.resume:p-1',
      },
      processedAt: null,
      nextAttemptAt: new Date(0),
      retryCount: 0,
      error: null,
      createdAt: new Date(),
    };

    prisma.userPromptResolution.findUnique.mockResolvedValue({ answers: { foo: 'bar' } });
    prisma.goalRun.findUnique.mockResolvedValue({ executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW });

    // First attempt: Temporal failure
    tx.$queryRaw.mockResolvedValueOnce([row]);
    await service.processBatch();

    expect(prisma.outbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o-1', processedAt: null },
        data: expect.objectContaining({
          retryCount: 1,
          error: expect.any(String),
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
    expect((prisma.outbox.updateMany as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('processedAt');
    expect(prisma.userPromptResolution.updateMany).not.toHaveBeenCalled();
    expect(resumeUpdateFailedTotal.inc).toHaveBeenCalledTimes(1);

    // Second attempt: Temporal success + ack + mark processed
    tx.$queryRaw.mockResolvedValueOnce([row]);
    prisma.outbox.updateMany.mockResolvedValue({ count: 1 });

    await service.processBatch();

    expect(temporalWorkflowService.resumeFromUserPrompt).toHaveBeenCalledTimes(2);
    expect(prisma.userPromptResolution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { promptId: 'p-1', resumeAcknowledgedAt: null },
        data: expect.objectContaining({ resumeAcknowledgedAt: expect.any(Date) }),
      }),
    );
    expect(resumeUpdateSuccessTotal.inc).toHaveBeenCalledTimes(1);
  });
});
