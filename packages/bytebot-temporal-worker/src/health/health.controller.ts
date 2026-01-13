/**
 * Health Controller
 *
 * Kubernetes health check endpoints for Temporal worker.
 * Implements standard liveness, readiness, and startup probes.
 */

import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { NativeConnection } from '@temporalio/worker';

// ============================================================================
// Custom Health Indicators
// ============================================================================

export class TemporalHealthIndicator extends HealthIndicator {
  private connection: NativeConnection | null = null;
  private isWorkerRunning = false;

  setConnection(connection: NativeConnection): void {
    this.connection = connection;
  }

  setWorkerRunning(running: boolean): void {
    this.isWorkerRunning = running;
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const isHealthy = this.connection !== null && this.isWorkerRunning;

    const result = this.getStatus(key, isHealthy, {
      connected: this.connection !== null,
      workerRunning: this.isWorkerRunning,
    });

    if (isHealthy) {
      return result;
    }
    throw new Error('Temporal worker is not healthy');
  }
}

// ============================================================================
// Health Controller
// ============================================================================

@Controller('health')
export class HealthController {
  private startTime: Date;
  private isReady = false;
  private temporalIndicator: TemporalHealthIndicator;

  constructor(private health: HealthCheckService) {
    this.startTime = new Date();
    this.temporalIndicator = new TemporalHealthIndicator();
  }

  getTemporalIndicator(): TemporalHealthIndicator {
    return this.temporalIndicator;
  }

  setReady(ready: boolean): void {
    this.isReady = ready;
  }

  /**
   * Liveness probe - is the process alive?
   * Kubernetes uses this to determine if the container should be restarted.
   */
  @Get('live')
  @HealthCheck()
  async liveness(): Promise<HealthCheckResult> {
    return this.health.check([
      // Simple memory check - if we're running, we're alive
      async () => ({
        memory: {
          status: 'up',
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          uptime: process.uptime(),
        },
      }),
    ]);
  }

  /**
   * Readiness probe - is the worker ready to accept work?
   * Kubernetes uses this to determine if the pod should receive traffic.
   */
  @Get('ready')
  @HealthCheck()
  async readiness(): Promise<HealthCheckResult> {
    if (!this.isReady) {
      throw new Error('Worker not ready');
    }

    return this.health.check([
      () => this.temporalIndicator.isHealthy('temporal'),
    ]);
  }

  /**
   * Startup probe - has the worker finished starting?
   * Kubernetes uses this to determine if liveness/readiness probes should start.
   */
  @Get('startup')
  async startup(): Promise<{ status: string; startTime: string; uptime: number }> {
    return {
      status: this.isReady ? 'started' : 'starting',
      startTime: this.startTime.toISOString(),
      uptime: process.uptime(),
    };
  }

  /**
   * Detailed health check for monitoring dashboards.
   */
  @Get()
  @HealthCheck()
  async check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.temporalIndicator.isHealthy('temporal'),
      async () => ({
        process: {
          status: 'up',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
          version: process.version,
        },
      }),
    ]);
  }
}
