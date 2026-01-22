import { Injectable, Logger } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from './prisma.service';
import { Outbox, Prisma } from '@prisma/client';

export interface EnqueueOutboxOnceRequest {
  dedupeKey: string;
  eventType: string;
  aggregateId?: string;
  payload: Prisma.InputJsonValue;
}

export type OutboxReplayEvent = {
  eventSequence: string;
  dedupeKey: string;
  aggregateId: string | null;
  eventType: string;
  payload: any;
  createdAt: string;
  processedAt: string | null;
};

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create (or return existing) outbox row.
   * Idempotent via unique Outbox.dedupeKey.
   */
  async enqueueOnce(request: EnqueueOutboxOnceRequest): Promise<Outbox> {
    try {
      return await this.prisma.outbox.create({
        data: {
          id: createId(),
          dedupeKey: request.dedupeKey,
          aggregateId: request.aggregateId,
          eventType: request.eventType,
          payload: request.payload,
        },
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') {
        throw error;
      }

      const existing = await this.prisma.outbox.findUnique({
        where: { dedupeKey: request.dedupeKey },
      });
      if (existing) {
        return existing;
      }

      this.logger.warn(`Outbox dedupe race for ${request.dedupeKey}; retrying`);
      return this.enqueueOnce(request);
    }
  }

  async replayEvents(request: {
    tenantId: string;
    cursor?: bigint;
    limit?: number;
    eventType?: string;
  }): Promise<{ events: OutboxReplayEvent[]; nextCursor: string | null }> {
    const cursor = request.cursor ?? 0n;
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 500);

    const rows = await this.prisma.$queryRaw<
      Array<{
        eventSequence: bigint;
        dedupeKey: string;
        aggregateId: string | null;
        eventType: string;
        payload: any;
        createdAt: Date;
        processedAt: Date | null;
      }>
    >`
      SELECT
        o.event_sequence AS "eventSequence",
        o.dedupe_key AS "dedupeKey",
        o.aggregate_id AS "aggregateId",
        o.event_type AS "eventType",
        o.payload AS "payload",
        o.created_at AS "createdAt",
        o.processed_at AS "processedAt"
      FROM "workflow_orchestrator"."outbox" o
      WHERE o.event_sequence IS NOT NULL
        AND o.event_sequence > ${cursor}
        AND (o.payload->>'tenantId') = ${request.tenantId}
        AND (${request.eventType ?? null}::text IS NULL OR o.event_type = ${request.eventType ?? null}::text)
      ORDER BY o.event_sequence ASC
      LIMIT ${limit};
    `;

    const events: OutboxReplayEvent[] = rows.map((r) => ({
      eventSequence: String(r.eventSequence),
      dedupeKey: r.dedupeKey,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
      processedAt: r.processedAt ? r.processedAt.toISOString() : null,
    }));

    const nextCursor = events.length > 0 ? events[events.length - 1].eventSequence : null;
    return { events, nextCursor };
  }
}
