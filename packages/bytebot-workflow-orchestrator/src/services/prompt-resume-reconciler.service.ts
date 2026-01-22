/**
 * Prompt Resume Reconciler Service
 *
 * Purpose:
 * - Ensures prompt resolutions always lead to a durable resume attempt.
 * - Repairs rare edge cases where a prompt is RESOLVED in DB but the resume outbox row is missing.
 *
 * Design:
 * - DB is the record of truth (prompt status + resolution record).
 * - Resume is executed via an outbox event (user_prompt.resume) processed by OutboxPublisherService.
 * - This reconciler is idempotent and safe under retries (dedupeKey uniqueness).
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import { PrismaService } from './prisma.service';
import { OutboxService } from './outbox.service';
import { LeaderElectionService } from './leader-election.service';

@Injectable()
export class PromptResumeReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(PromptResumeReconcilerService.name);

  private readonly enabled: boolean;
  private readonly lookbackMinutes: number;
  private readonly batchSize: number;
  private readonly graceSeconds: number;
  private readonly reconcileBucketMinutes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly outboxService: OutboxService,
    private readonly leaderElection: LeaderElectionService,
    @InjectMetric('resume_outbox_enqueued_total')
    private readonly resumeOutboxEnqueuedTotal: Counter<string>,
  ) {
    this.enabled = this.configService.get<string>('PROMPT_RESUME_RECONCILER_ENABLED', 'true') === 'true';
    this.lookbackMinutes = parseInt(
      this.configService.get<string>('PROMPT_RESUME_RECONCILER_LOOKBACK_MINUTES', '1440'), // 24h
      10,
    );
    this.batchSize = parseInt(
      this.configService.get<string>('PROMPT_RESUME_RECONCILER_BATCH_SIZE', '50'),
      10,
    );
    this.graceSeconds = parseInt(
      this.configService.get<string>('PROMPT_RESUME_RECONCILER_GRACE_SECONDS', '30'),
      10,
    );
    this.reconcileBucketMinutes = parseInt(
      this.configService.get<string>('PROMPT_RESUME_RECONCILER_BUCKET_MINUTES', '5'),
      10,
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('Prompt resume reconciler is disabled');
      return;
    }
    this.logger.log(
      `Prompt resume reconciler enabled (lookbackMinutes=${this.lookbackMinutes}, batchSize=${this.batchSize})`,
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (!this.leaderElection.isLeader) return;

    try {
      await this.reconcile();
    } catch (error: any) {
      this.logger.warn(`Prompt resume reconcile tick failed: ${error.message}`);
    }
  }

  private async reconcile(): Promise<void> {
    const since = new Date(Date.now() - this.lookbackMinutes * 60 * 1000);
    const graceCutoff = new Date(Date.now() - this.graceSeconds * 1000);
    const rearmCutoff = new Date(Date.now() - this.reconcileBucketMinutes * 60 * 1000);

    const candidates = await this.prisma.$queryRaw<
      Array<{
        promptId: string;
        goalRunId: string;
        tenantId: string | null;
        outboxId: string | null;
        outboxProcessedAt: Date | null;
      }>
    >`
      SELECT
        p.id AS "promptId",
        p.goal_run_id AS "goalRunId",
        p.tenant_id AS "tenantId",
        o.id AS "outboxId",
        o.processed_at AS "outboxProcessedAt"
      FROM "workflow_orchestrator"."user_prompts" p
      JOIN "workflow_orchestrator"."goal_runs" gr
        ON gr.id = p.goal_run_id
      LEFT JOIN "workflow_orchestrator"."user_prompt_resolutions" r
        ON r.prompt_id = p.id
      LEFT JOIN "workflow_orchestrator"."outbox" o
        ON o.dedupe_key = ('user_prompt.resume:' || p.id)
      WHERE p.status = 'RESOLVED'
        AND p.resolved_at IS NOT NULL
        AND p.resolved_at >= ${since}
        AND p.resolved_at <= ${graceCutoff}
        AND gr.status IN ('PENDING', 'RUNNING')
        AND gr.execution_engine = 'TEMPORAL_WORKFLOW'
        AND (r.resume_acknowledged_at IS NULL)
        -- Prefer the canonical outbox row; only repair when missing, or when it was processed
        -- without a durable resume ack (i.e., needs a re-arm) and the last processing is older
        -- than the configured reconcile bucket.
        AND (
          o.id IS NULL
          OR (
            o.processed_at IS NOT NULL
            AND o.processed_at <= ${rearmCutoff}
          )
        )
      ORDER BY p.resolved_at DESC
      LIMIT ${this.batchSize};
    `;

    if (candidates.length === 0) return;

    this.logger.warn(`Found ${candidates.length} resolved prompts needing resume reconciliation; enqueueing repairs`);

    for (const row of candidates) {
      const canonicalDedupeKey = `user_prompt.resume:${row.promptId}`;

      if (!row.outboxId) {
        await this.outboxService.enqueueOnce({
          dedupeKey: canonicalDedupeKey,
          aggregateId: row.goalRunId,
          eventType: 'user_prompt.resume',
          payload: {
            promptId: row.promptId,
            goalRunId: row.goalRunId,
            tenantId: row.tenantId,
            updateId: canonicalDedupeKey,
            source: 'reconciler',
          },
        });

        try {
          this.resumeOutboxEnqueuedTotal.labels('reconciler').inc();
        } catch {
          // Ignore metric errors
        }
        continue;
      }

      // Re-arm the canonical outbox row instead of creating unbounded new outbox rows.
      // This keeps the outbox table growth predictable under extended Temporal outages.
      await this.prisma.outbox.updateMany({
        where: {
          id: row.outboxId,
          processedAt: { not: null },
        },
        data: {
          processedAt: null,
          retryCount: 0,
          nextAttemptAt: new Date(),
        },
      });

      try {
        this.resumeOutboxEnqueuedTotal.labels('reconciler_rearm').inc();
      } catch {
        // Ignore metric errors
      }
    }
  }
}
