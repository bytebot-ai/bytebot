/**
 * Health Controller
 * v2.1.0: Phase E maintenance mode status endpoints
 * v2.0.0: Phase 7 Multi-Agent Orchestration
 *
 * Kubernetes health checks, readiness probes, leader status,
 * maintenance mode status, and multi-agent orchestration health.
 */

import { Controller, Get, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../services/prisma.service';
import { LeaderElectionService } from '../services/leader-election.service';
import { SchedulerService } from '../services/scheduler.service';
import { AgentRegistryService } from '../services/agent-registry.service';
import { AgentHealthService } from '../services/agent-health.service';
import { MaintenanceModeService, MaintenanceState, EnterMaintenanceOptions } from '../services/maintenance-mode.service';

@Controller('health')
@SkipThrottle() // Health checks should not be rate limited
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prismaHealth: PrismaHealthIndicator,
    private prisma: PrismaService,
    private leaderElection: LeaderElectionService,
    private scheduler: SchedulerService,
    private agentRegistry: AgentRegistryService,
    private agentHealth: AgentHealthService,
    private maintenanceMode: MaintenanceModeService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
    ]);
  }

  @Get('live')
  liveness() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    // v2.1.0 Phase E: Include maintenance mode in readiness
    const maintenanceStatus = this.maintenanceMode.getStatus();

    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      // Maintenance mode check - mark as not ready if in maintenance
      async () => {
        if (maintenanceStatus.state === MaintenanceState.MAINTENANCE) {
          return {
            maintenance: {
              status: 'down',
              message: 'System in maintenance mode',
              reason: maintenanceStatus.reason,
              expectedEndAt: maintenanceStatus.expectedEndAt?.toISOString(),
            },
          };
        }
        return {
          maintenance: {
            status: 'up',
            state: maintenanceStatus.state,
            acceptingNewWork: maintenanceStatus.acceptingNewWork,
          },
        };
      },
    ]);
  }

  /**
   * Get leader election status for monitoring
   */
  @Get('leader')
  leaderStatus() {
    const status = this.leaderElection.getLeadershipStatus();
    return {
      success: true,
      ...status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get scheduler status for monitoring
   */
  @Get('scheduler')
  schedulerStatus() {
    const status = this.scheduler.getSchedulerStatus();
    return {
      success: true,
      ...status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get multi-agent orchestration status
   * Phase 7: Multi-Agent Orchestration
   */
  @Get('agents')
  async agentsStatus() {
    const registryStats = await this.agentRegistry.getStats();
    const healthSummary = await this.agentHealth.getOverallHealthSummary();

    return {
      success: true,
      registry: registryStats,
      health: {
        avgSuccessRate: healthSummary.avgSuccessRate,
        avgLatencyMs: healthSummary.avgLatencyMs,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get maintenance mode status
   * Phase E: Maintenance mode handling
   */
  @Get('maintenance')
  maintenanceStatus() {
    const status = this.maintenanceMode.getStatus();
    return {
      success: true,
      ...status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Enter maintenance mode
   * Phase E: Maintenance mode handling
   *
   * Starts graceful drain process:
   * 1. Stop accepting new work
   * 2. Wait for in-progress work to complete (up to drainTimeoutMs)
   * 3. Pause remaining goal runs
   * 4. Enter maintenance state
   */
  @Post('maintenance/enter')
  @HttpCode(HttpStatus.OK)
  async enterMaintenance(
    @Body() options: EnterMaintenanceOptions,
  ) {
    const status = await this.maintenanceMode.enterMaintenance(options);
    return {
      success: true,
      message: 'Maintenance mode initiated',
      ...status,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Exit maintenance mode
   * Phase E: Maintenance mode handling
   *
   * Resumes normal operation:
   * 1. Resume goal runs that were paused by maintenance
   * 2. Accept new work
   * 3. Return to running state
   */
  @Post('maintenance/exit')
  @HttpCode(HttpStatus.OK)
  async exitMaintenance() {
    const status = await this.maintenanceMode.exitMaintenance();
    return {
      success: true,
      message: 'Maintenance mode ended',
      ...status,
      timestamp: new Date().toISOString(),
    };
  }
}
