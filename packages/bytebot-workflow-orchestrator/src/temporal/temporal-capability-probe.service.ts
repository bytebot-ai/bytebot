import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@temporalio/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Gauge } from 'prom-client';
import { TEMPORAL_CLIENT } from './constants';

type TemporalCapabilityProbeMode = 'REACHABILITY' | 'UPDATE';

@Injectable()
export class TemporalCapabilityProbeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporalCapabilityProbeService.name);

  private healthy = false;
  private lastError: string | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    @Optional() @Inject(TEMPORAL_CLIENT) private readonly client: Client | null,
    private readonly configService: ConfigService,
    @InjectMetric('temporal_capability_probe_ok') private readonly okGauge: Gauge<string>,
    @InjectMetric('temporal_capability_probe_failures_total')
    private readonly failuresCounter: Counter<string>,
  ) {}

  onModuleInit(): void {
    // Fire-and-forget initial probe so we have a signal quickly after startup.
    void this.probeOnce();

    // Use an unref'ed interval so tests and short-lived processes can exit cleanly.
    const mode = this.getMode();
    const defaultIntervalMs = mode === 'UPDATE' ? 300000 : 30000;
    const intervalMs = parseInt(process.env.TEMPORAL_CAPABILITY_PROBE_INTERVAL_MS ?? String(defaultIntervalMs), 10);
    this.intervalHandle = setInterval(() => void this.probeOnce(), intervalMs);
    this.intervalHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isHealthyForTraffic(): boolean {
    return this.healthy;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async probeOnce(): Promise<void> {
    const enabled = this.configService.get<string>('TEMPORAL_WORKFLOW_ENABLED', 'false') === 'true';
    if (!enabled) {
      this.setDisabled();
      return;
    }

    if (!this.client) {
      this.setUnhealthy('TEMPORAL_CLIENT_UNAVAILABLE');
      return;
    }

    try {
      const mode = this.getMode();
      if (mode === 'UPDATE') {
        await this.probeUpdateCapabilityOnce();
      } else {
        // "Server reachable" capability check. This is intentionally lightweight.
        // CI Update-contract tests cover handler registration correctness.
        await this.client.workflowService.getSystemInfo({});
      }
      this.setHealthy();
    } catch (error: any) {
      this.setUnhealthy(String(error?.message ?? error));
    }
  }

  private getMode(): TemporalCapabilityProbeMode {
    const raw = this.configService.get<string>('TEMPORAL_CAPABILITY_PROBE_MODE', 'REACHABILITY');
    const normalized = String(raw ?? '')
      .trim()
      .toUpperCase();

    if (normalized === 'UPDATE') return 'UPDATE';
    return 'REACHABILITY';
  }

  private async probeUpdateCapabilityOnce(): Promise<void> {
    if (!this.client) throw new Error('TEMPORAL_CLIENT_UNAVAILABLE');

    const taskQueue = this.configService.get<string>('TEMPORAL_TASK_QUEUE', '').trim();
    if (!taskQueue) {
      throw new Error('TEMPORAL_TASK_QUEUE is required for UPDATE probe mode');
    }

    const podName = this.configService.get<string>('POD_NAME', '').trim() || 'unknown-pod';
    const nowToken = new Date().toISOString().replace(/[^a-zA-Z0-9_-]/g, '-');

    // Unique workflow ID per probe attempt (keeps the probe side-effect free and avoids workflowId collisions).
    // Execution timeout is short so even failures do not leave long-running probe workflows behind.
    const workflowId = `bytebot-capability-probe-${podName}-${nowToken}`;

    await this.client.workflow.start('goalRunWorkflow', {
      taskQueue,
      workflowId,
      workflowExecutionTimeout: '1m',
      args: [
        {
          goalRunId: workflowId,
          tenantId: 'system',
          userId: 'system',
          goalDescription: 'Temporal Update capability probe',
          constraints: {
            maxSteps: 1,
            maxRetries: 0,
            maxReplans: 0,
            timeoutMs: 60000,
            requireApprovalForHighRisk: false,
          },
          context: { previousAttempts: 0, inheritedKnowledge: [] },
          mode: 'CAPABILITY_PROBE',
        },
      ],
    });

    const handle = this.client.workflow.getHandle(workflowId);

    const updateResult = (await handle.executeUpdate('userPromptResolved', {
      updateId: `temporal_capability_probe:${workflowId}`,
      args: [{ promptId: workflowId, answers: { ok: true } }],
    })) as { accepted?: boolean; applied?: boolean };

    if (!updateResult?.accepted) {
      throw new Error(`Update did not accept probe payload: ${JSON.stringify(updateResult)}`);
    }
  }

  private setHealthy(): void {
    if (!this.healthy) {
      this.logger.log('Temporal capability probe recovered (allowing Temporal routing for new runs)');
    }
    this.healthy = true;
    this.lastError = null;
    this.okGauge.set(1);
  }

  private setUnhealthy(reason: string): void {
    const wasHealthy = this.healthy;
    this.healthy = false;
    this.lastError = reason;
    this.okGauge.set(0);

    // Count failures, but avoid spamming logs every interval.
    this.failuresCounter.inc();
    if (wasHealthy) {
      this.logger.error(`Temporal capability probe failed; gating Temporal routing. reason=${reason}`);
    }
  }

  private setDisabled(): void {
    this.healthy = false;
    this.lastError = 'TEMPORAL_DISABLED';
    this.okGauge.set(0);
  }
}
