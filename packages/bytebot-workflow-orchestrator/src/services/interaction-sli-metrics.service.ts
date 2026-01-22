import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Gauge } from 'prom-client';
import { PrismaService } from './prisma.service';

@Injectable()
export class InteractionSliMetricsService implements OnModuleInit {
  private readonly logger = new Logger(InteractionSliMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectMetric('runs_stuck_waiting_user_input_total')
    private readonly runsStuckWaitingUserInputTotal: Gauge<string>,
    @InjectMetric('runs_stuck_waiting_provider_total')
    private readonly runsStuckWaitingProviderTotal: Gauge<string>,
    @InjectMetric('runs_stuck_waiting_capacity_total')
    private readonly runsStuckWaitingCapacityTotal: Gauge<string>,
    @InjectMetric('prompts_resolved_without_resume_ack_total')
    private readonly promptsResolvedWithoutResumeAckTotal: Gauge<string>,
  ) {}

  onModuleInit(): void {
    this.logger.log('Interaction SLI metrics enabled');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    try {
      await this.refresh();
    } catch (error: any) {
      this.logger.debug(`Interaction SLI refresh failed: ${error?.message || String(error)}`);
    }
  }

  private async refresh(): Promise<void> {
    type WaitingBuckets = {
      lt_5m: bigint;
      m5_15: bigint;
      m15_1h: bigint;
      h1_24: bigint;
      gt_24h: bigint;
    };

    const waitingRows = await this.prisma.$queryRaw<Array<{ phase: string } & WaitingBuckets>>`
      SELECT
        gr.phase,
        SUM(CASE WHEN COALESCE(gr.wait_started_at, gr.updated_at) >= NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END)::bigint AS lt_5m,
        SUM(CASE WHEN COALESCE(gr.wait_started_at, gr.updated_at) < NOW() - INTERVAL '5 minutes' AND COALESCE(gr.wait_started_at, gr.updated_at) >= NOW() - INTERVAL '15 minutes' THEN 1 ELSE 0 END)::bigint AS m5_15,
        SUM(CASE WHEN COALESCE(gr.wait_started_at, gr.updated_at) < NOW() - INTERVAL '15 minutes' AND COALESCE(gr.wait_started_at, gr.updated_at) >= NOW() - INTERVAL '1 hour' THEN 1 ELSE 0 END)::bigint AS m15_1h,
        SUM(CASE WHEN COALESCE(gr.wait_started_at, gr.updated_at) < NOW() - INTERVAL '1 hour' AND COALESCE(gr.wait_started_at, gr.updated_at) >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END)::bigint AS h1_24,
        SUM(CASE WHEN COALESCE(gr.wait_started_at, gr.updated_at) < NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END)::bigint AS gt_24h
      FROM "workflow_orchestrator"."goal_runs" gr
      WHERE gr.status IN ('PENDING', 'RUNNING')
        AND gr.phase IN ('WAITING_USER_INPUT', 'WAITING_PROVIDER', 'WAITING_CAPACITY')
      GROUP BY gr.phase;
    `;

    const zeros: WaitingBuckets = { lt_5m: 0n, m5_15: 0n, m15_1h: 0n, h1_24: 0n, gt_24h: 0n };
    const byPhase = new Map<string, WaitingBuckets>(
      waitingRows.map((row) => [
        row.phase,
        {
          lt_5m: row.lt_5m ?? 0n,
          m5_15: row.m5_15 ?? 0n,
          m15_1h: row.m15_1h ?? 0n,
          h1_24: row.h1_24 ?? 0n,
          gt_24h: row.gt_24h ?? 0n,
        },
      ]),
    );

    const setBuckets = (metric: Gauge<string>, buckets: WaitingBuckets) => {
      metric.labels('lt_5m').set(Number(buckets.lt_5m ?? 0n));
      metric.labels('5m_15m').set(Number(buckets.m5_15 ?? 0n));
      metric.labels('15m_1h').set(Number(buckets.m15_1h ?? 0n));
      metric.labels('1h_24h').set(Number(buckets.h1_24 ?? 0n));
      metric.labels('gt_24h').set(Number(buckets.gt_24h ?? 0n));
    };

    setBuckets(this.runsStuckWaitingUserInputTotal, byPhase.get('WAITING_USER_INPUT') ?? zeros);
    setBuckets(this.runsStuckWaitingProviderTotal, byPhase.get('WAITING_PROVIDER') ?? zeros);
    setBuckets(this.runsStuckWaitingCapacityTotal, byPhase.get('WAITING_CAPACITY') ?? zeros);

    const [{ count }] = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "workflow_orchestrator"."user_prompt_resolutions" r
      JOIN "workflow_orchestrator"."user_prompts" p
        ON p.id = r.prompt_id
      JOIN "workflow_orchestrator"."goal_runs" gr
        ON gr.id = p.goal_run_id
      WHERE p.status = 'RESOLVED'
        AND p.resolved_at IS NOT NULL
        AND p.resolved_at < NOW() - INTERVAL '30 seconds'
        AND r.resume_acknowledged_at IS NULL
        AND gr.status IN ('PENDING', 'RUNNING')
        AND gr.execution_engine = 'TEMPORAL_WORKFLOW';
    `;

    this.promptsResolvedWithoutResumeAckTotal.set(Number(count ?? 0n));
  }
}
