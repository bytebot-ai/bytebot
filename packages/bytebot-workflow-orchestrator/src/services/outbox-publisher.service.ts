/**
 * Outbox Publisher Service (PR 3)
 *
 * Implements a DB-backed relay for the transactional outbox:
 * - Reads pending rows from workflow_orchestrator.outbox
 * - Publishes notifications (Slack/Teams) using stable dedupe keys
 * - Marks rows processed only after successful publish
 * - Retries with exponential backoff via nextAttemptAt
 *
 * Runs only on the elected leader to avoid duplicate publishing.
 */

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { GoalRunExecutionEngine, Outbox, UserPromptStatus } from '@prisma/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import { PrismaService } from './prisma.service';
import { SlackEventType, SlackNotificationService, UserPromptEventData as SlackUserPromptEventData } from './slack-notification.service';
import { TeamsEventType, TeamsNotificationService, UserPromptEventData as TeamsUserPromptEventData } from './teams-notification.service';
import { LeaderElectionService } from './leader-election.service';
import { TemporalWorkflowService } from '../temporal/temporal-workflow.service';

type UserPromptOutboxPayload = {
  promptId: string;
  tenantId?: string | null;
  goalRunId: string;
  checklistItemId: string | null;
  goalSpecId?: string | null;
  kind?: string;
  stepDescription?: string | null;
  links?: { goalRun?: string; prompt?: string; desktopTakeover?: string | null };
};

type UserPromptResumeOutboxPayload = {
  promptId: string;
  goalRunId: string;
  updateId?: string;
};

@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(OutboxPublisherService.name);

  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly claimLeaseSeconds: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  private isProcessing = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly leaderElection: LeaderElectionService,
    private readonly slack: SlackNotificationService,
    private readonly teams: TeamsNotificationService,
    @InjectMetric('outbox_pending_total')
    private readonly outboxPendingTotal: Gauge<string>,
    @InjectMetric('outbox_oldest_pending_age_seconds')
    private readonly outboxOldestPendingAgeSeconds: Gauge<string>,
    @InjectMetric('outbox_publish_attempts_total')
    private readonly outboxPublishAttemptsTotal: Counter<string>,
    @InjectMetric('user_prompts_open_total')
    private readonly userPromptsOpenTotal: Gauge<string>,
    @InjectMetric('resume_update_success_total')
    private readonly resumeUpdateSuccessTotal: Counter<string>,
    @InjectMetric('resume_update_failed_total')
    private readonly resumeUpdateFailedTotal: Counter<string>,
    @Optional() private readonly temporalWorkflowService?: TemporalWorkflowService,
  ) {
    this.enabled = this.configService.get<string>('OUTBOX_PUBLISHER_ENABLED', 'true') === 'true';
    this.batchSize = parseInt(this.configService.get<string>('OUTBOX_PUBLISHER_BATCH_SIZE', '25'), 10);
    this.claimLeaseSeconds = parseInt(
      this.configService.get<string>('OUTBOX_PUBLISHER_CLAIM_LEASE_SECONDS', '60'),
      10,
    );
    this.maxRetries = parseInt(this.configService.get<string>('OUTBOX_PUBLISHER_MAX_RETRIES', '20'), 10);
    this.retryBaseDelayMs = parseInt(this.configService.get<string>('OUTBOX_PUBLISHER_RETRY_BASE_DELAY_MS', '30000'), 10);
    this.retryMaxDelayMs = parseInt(this.configService.get<string>('OUTBOX_PUBLISHER_RETRY_MAX_DELAY_MS', '600000'), 10);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Outbox publisher is disabled');
      return;
    }
    this.logger.log(
      `Outbox publisher enabled (batchSize=${this.batchSize}, maxRetries=${this.maxRetries}, baseDelayMs=${this.retryBaseDelayMs})`,
    );
    this.logger.log('Outbox publisher will start processing when this instance becomes leader');
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async tick(): Promise<void> {
    try {
      await this.updateGauges(new Date());
    } catch (error: any) {
      this.logger.debug(`Outbox gauge refresh failed: ${error.message}`);
    }

    if (!this.enabled) return;
    if (!this.leaderElection.isLeader) return;
    if (this.isProcessing) return;

    this.isProcessing = true;
    try {
      await this.processBatch();
    } catch (error: any) {
      this.logger.error(`Outbox publisher tick error: ${error.message}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async processBatch(): Promise<number> {
    const now = new Date();

    const leaseUntil = new Date(now.getTime() + this.claimLeaseSeconds * 1000);

    const rows = await this.prisma.$transaction(async (tx) => {
      // Claim rows atomically using row-level locks (multiple replicas safe).
      // We "lease" claimed rows by pushing next_attempt_at forward; if the worker crashes,
      // rows become eligible again after the lease expires.
      return tx.$queryRaw<Outbox[]>`
        WITH claimed AS (
          SELECT id
          FROM "workflow_orchestrator"."outbox"
          WHERE "processed_at" IS NULL
            AND "next_attempt_at" <= ${now}
          ORDER BY "created_at" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.batchSize}
        )
        UPDATE "workflow_orchestrator"."outbox" o
        SET "next_attempt_at" = ${leaseUntil}
        FROM claimed
        WHERE o.id = claimed.id
        RETURNING
          o.id,
          o.dedupe_key AS "dedupeKey",
          o.aggregate_id AS "aggregateId",
          o.event_type AS "eventType",
          o.payload,
          o.processed_at AS "processedAt",
          o.retry_count AS "retryCount",
          o.error,
          o.created_at AS "createdAt",
          o.next_attempt_at AS "nextAttemptAt";
      `;
    });

    for (const row of rows) {
      await this.processRow(row);
    }

    return rows.length;
  }

  private async updateGauges(now: Date): Promise<void> {
    const pendingByType = await this.prisma.outbox.groupBy({
      by: ['eventType'],
      where: { processedAt: null },
      _count: { _all: true },
    });

    this.outboxPendingTotal.reset();
    for (const row of pendingByType) {
      this.outboxPendingTotal.labels(row.eventType).set(row._count._all);
    }

    const oldestPending = await this.prisma.outbox.findFirst({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    const oldestAgeSeconds = oldestPending ? (now.getTime() - oldestPending.createdAt.getTime()) / 1000 : 0;
    this.outboxOldestPendingAgeSeconds.set(oldestAgeSeconds);

    const openPromptsByKind = await this.prisma.userPrompt.groupBy({
      by: ['kind'],
      where: { status: UserPromptStatus.OPEN },
      _count: { _all: true },
    });

    this.userPromptsOpenTotal.reset();
    for (const row of openPromptsByKind) {
      this.userPromptsOpenTotal.labels(row.kind).set(row._count._all);
    }
  }

  private async processRow(row: Outbox): Promise<void> {
    try {
      await this.publishRow(row);

      this.outboxPublishAttemptsTotal.labels(row.eventType, 'success').inc();

      await this.prisma.outbox.updateMany({
        where: { id: row.id, processedAt: null },
        data: { processedAt: new Date(), error: null },
      });
    } catch (error: any) {
      this.outboxPublishAttemptsTotal.labels(row.eventType, 'failure').inc();

      const retryCount = (row.retryCount ?? 0) + 1;
      const nextAttemptAt = this.computeNextAttemptAt(new Date(), retryCount);
      const message = this.truncateError(error?.message || String(error));

      const shouldGiveUp = retryCount >= this.maxRetries;

      await this.prisma.outbox.updateMany({
        where: { id: row.id, processedAt: null },
        data: {
          retryCount,
          error: message,
          nextAttemptAt,
          ...(shouldGiveUp ? { processedAt: new Date() } : {}),
        },
      });

      if (shouldGiveUp) {
        this.logger.error(`Outbox row ${row.id} gave up after ${retryCount} attempts: ${message}`);
      } else {
        this.logger.warn(`Outbox row ${row.id} publish failed (attempt ${retryCount}); retry at ${nextAttemptAt.toISOString()}: ${message}`);
      }
    }
  }

  private async publishRow(row: Outbox): Promise<void> {
    switch (row.eventType) {
      case SlackEventType.USER_PROMPT_CREATED:
      case SlackEventType.USER_PROMPT_RESOLVED:
      case SlackEventType.USER_PROMPT_CANCELLED:
        await this.publishUserPrompt(row, row.eventType);
        return;
      case 'user_prompt.resume':
        await this.resumeUserPrompt(row);
        return;
      default:
        throw new Error(`Unknown outbox eventType=${row.eventType}`);
    }
  }

  private async publishUserPrompt(
    row: Outbox,
    eventType:
      | SlackEventType.USER_PROMPT_CREATED
      | SlackEventType.USER_PROMPT_RESOLVED
      | SlackEventType.USER_PROMPT_CANCELLED,
  ): Promise<void> {
    const payload = row.payload as unknown as UserPromptOutboxPayload;

    const tenantId = await this.resolveTenantId(payload.tenantId ?? null, payload.goalRunId ?? row.aggregateId ?? null);
    if (!tenantId) {
      throw new Error(`Missing tenantId for outbox row ${row.id} (${row.eventType})`);
    }

    const data: SlackUserPromptEventData & TeamsUserPromptEventData = {
      promptId: payload.promptId,
      tenantId,
      goalRunId: payload.goalRunId,
      checklistItemId: payload.checklistItemId,
      kind: payload.kind || 'TEXT_CLARIFICATION',
      stepDescription: payload.stepDescription ?? null,
      links: payload.links,
    };

    const [slackResults, teamsResults] = await Promise.all([
      this.slack.sendUserPromptNotification(eventType, data, { eventId: row.dedupeKey }),
      this.teams.sendUserPromptNotification(eventType as unknown as TeamsEventType, data, { eventId: row.dedupeKey }),
    ]);

    const failures = [...slackResults, ...teamsResults].filter((r) => !r.success);
    if (failures.length > 0) {
      throw new Error(`Notification delivery failures: ${failures.length}`);
    }
  }

  private async resumeUserPrompt(row: Outbox): Promise<void> {
    const payload = row.payload as unknown as UserPromptResumeOutboxPayload;
    if (!payload?.promptId || !payload?.goalRunId) {
      throw new Error(`Invalid resume payload for outbox row ${row.id}`);
    }

    const updateId = payload.updateId || row.dedupeKey;

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: payload.goalRunId },
      select: { executionEngine: true },
    });

    if (!goalRun) {
      throw new Error(`Missing goal run for resume ${payload.promptId} (goalRunId=${payload.goalRunId})`);
    }

    if (goalRun.executionEngine === GoalRunExecutionEngine.LEGACY_DB_LOOP) {
      // Legacy orchestrator (DB loop) does not require Temporal resume, but we still
      // must ack durably to prevent reconciler churn and false-positive alerting.
      const ackedAt = new Date();
      await this.prisma.userPromptResolution.updateMany({
        where: {
          promptId: payload.promptId,
          resumeAcknowledgedAt: null,
        },
        data: {
          resumeAcknowledgedAt: ackedAt,
          resumeAck: {
            acknowledgedAt: ackedAt.toISOString(),
            didResume: false,
            updateId,
            skipped: true,
            skipReason: 'LEGACY_ENGINE',
            executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
            outboxRowId: row.id,
            outboxDedupeKey: row.dedupeKey,
          } as any,
        },
      });
      return;
    }

    // For TEMPORAL_WORKFLOW runs, we only ack after a successful Temporal Update.
    // If Temporal is disabled/unreachable, that is a delivery failure (not a skip).
    if (!this.temporalWorkflowService?.isEnabled()) {
      throw new Error(
        `Temporal workflows disabled but run execution_engine=TEMPORAL_WORKFLOW (goalRunId=${payload.goalRunId})`,
      );
    }

    const resolution = await this.prisma.userPromptResolution.findUnique({
      where: { promptId: payload.promptId },
      select: { answers: true },
    });

    const answers =
      (resolution?.answers as unknown as Record<string, any> | null) ??
      (await this.prisma.userPrompt.findUnique({
        where: { id: payload.promptId },
        select: { answers: true },
      }))?.answers;

    if (!answers || typeof answers !== 'object') {
      throw new Error(`Missing answers for prompt resume ${payload.promptId}`);
    }
    let resumeResult: { didResume: boolean };
    try {
      resumeResult = await this.temporalWorkflowService.resumeFromUserPrompt(
        payload.goalRunId,
        { promptId: payload.promptId, answers: answers as any },
        { updateId },
      );
      this.resumeUpdateSuccessTotal.inc();
    } catch (error: any) {
      this.resumeUpdateFailedTotal.inc();
      throw error;
    }

    // Acknowledge resume attempt durably so a reconciler can prove convergence:
    // DB prompt RESOLVED + resume_acknowledged_at set ⇒ we delivered (or intentionally skipped) the resume Update.
    const ackedAt = new Date();
    await this.prisma.userPromptResolution.updateMany({
      where: {
        promptId: payload.promptId,
        resumeAcknowledgedAt: null,
      },
      data: {
        resumeAcknowledgedAt: ackedAt,
        resumeAck: {
          acknowledgedAt: ackedAt.toISOString(),
          didResume: resumeResult.didResume,
          updateId,
          executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
          outboxRowId: row.id,
          outboxDedupeKey: row.dedupeKey,
        } as any,
      },
    });
  }

  private async resolveTenantId(tenantId: string | null, goalRunId: string | null): Promise<string | null> {
    if (tenantId) return tenantId;
    if (!goalRunId) return null;

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
      select: { tenantId: true },
    });

    return goalRun?.tenantId ?? null;
  }

  private computeNextAttemptAt(now: Date, retryCount: number): Date {
    const exponent = Math.max(0, retryCount - 1);
    const delay = Math.min(this.retryBaseDelayMs * Math.pow(2, exponent), this.retryMaxDelayMs);
    return new Date(now.getTime() + delay);
  }

  private truncateError(message: string): string {
    return message.length > 2000 ? `${message.slice(0, 2000)}…` : message;
  }
}
