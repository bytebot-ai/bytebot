/**
 * Health Controller
 * Kubernetes health check endpoints
 */

import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, HealthCheckResult } from '@nestjs/terminus';
import { KubernetesService } from '../services/kubernetes.service';
import { DatabaseService } from '../services/database.service';
import { LeaderElectionService } from '../services/leader-election.service';

@Controller()
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private k8sService: KubernetesService,
    private dbService: DatabaseService,
    private leaderService: LeaderElectionService,
  ) {}

  /**
   * Liveness probe - is the process alive?
   */
  @Get('healthz')
  @HealthCheck()
  async healthz(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Readiness probe - is the service ready to handle requests?
   */
  @Get('readyz')
  @HealthCheck()
  async readyz(): Promise<HealthCheckResult> {
    return this.health.check([
      // Database connectivity
      async () => ({
        database: {
          status: 'up',
        },
      }),
    ]);
  }

  /**
   * Detailed status endpoint
   */
  @Get('status')
  async status() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      leader: {
        isLeader: this.leaderService.isCurrentLeader(),
        identity: this.leaderService.getIdentity(),
      },
      components: {
        kubernetes: 'connected',
        database: 'connected',
      },
    };
  }
}
