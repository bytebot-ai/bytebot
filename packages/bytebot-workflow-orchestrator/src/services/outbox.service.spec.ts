import { OutboxService } from './outbox.service';

describe(OutboxService.name, () => {
  it('creates an outbox row on first call', async () => {
    const prisma = {
      outbox: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    } as any;

    const service = new OutboxService(prisma);

    const created = {
      id: 'o1',
      dedupeKey: 'prompt:run1:step1:TEXT_CLARIFICATION',
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    };

    prisma.outbox.create.mockResolvedValueOnce(created);

    const result = await service.enqueueOnce({
      dedupeKey: created.dedupeKey,
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    });

    expect(result).toBe(created);
    expect(prisma.outbox.create).toHaveBeenCalledTimes(1);
  });

  it('dedupes by returning existing outbox row on unique violation', async () => {
    const prisma = {
      outbox: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    } as any;

    const service = new OutboxService(prisma);

    const existing = {
      id: 'o1',
      dedupeKey: 'prompt:run1:step1:TEXT_CLARIFICATION',
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    };

    prisma.outbox.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.outbox.findUnique.mockResolvedValueOnce(existing);

    const result = await service.enqueueOnce({
      dedupeKey: existing.dedupeKey,
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    });

    expect(result).toBe(existing);
    expect(prisma.outbox.findUnique).toHaveBeenCalledWith({
      where: { dedupeKey: existing.dedupeKey },
    });
  });

  it('retries if dedupe race returns null', async () => {
    const prisma = {
      outbox: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
    } as any;

    const service = new OutboxService(prisma);

    const created = {
      id: 'o1',
      dedupeKey: 'prompt:run1:step1:TEXT_CLARIFICATION',
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    };

    prisma.outbox.create.mockRejectedValueOnce({ code: 'P2002' }).mockResolvedValueOnce(created);
    prisma.outbox.findUnique.mockResolvedValueOnce(null);

    const result = await service.enqueueOnce({
      dedupeKey: created.dedupeKey,
      aggregateId: 'run1',
      eventType: 'user_prompt.created',
      payload: { foo: 'bar' },
    });

    expect(result).toBe(created);
    expect(prisma.outbox.create).toHaveBeenCalledTimes(2);
  });

  it('replays events with cursor and returns nextCursor', async () => {
    const prisma = {
      $queryRaw: jest.fn(),
    } as any;

    const service = new OutboxService(prisma);

    prisma.$queryRaw.mockResolvedValueOnce([
      {
        eventSequence: 5n,
        dedupeKey: 'user_prompt.created:p-1',
        aggregateId: 'gr-1',
        eventType: 'user_prompt.created',
        payload: { tenantId: 't-1', promptId: 'p-1' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        processedAt: null,
      },
      {
        eventSequence: 6n,
        dedupeKey: 'user_prompt.resolved:p-1',
        aggregateId: 'gr-1',
        eventType: 'user_prompt.resolved',
        payload: { tenantId: 't-1', promptId: 'p-1' },
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
        processedAt: new Date('2026-01-01T00:01:01.000Z'),
      },
    ]);

    const result = await service.replayEvents({ tenantId: 't-1', cursor: 0n, limit: 10 });

    expect(result.events).toHaveLength(2);
    expect(result.events[0].eventSequence).toBe('5');
    expect(result.events[1].eventSequence).toBe('6');
    expect(result.nextCursor).toBe('6');
  });
});
