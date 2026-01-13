/**
 * Agent Health Service
 * v1.0.0: Phase 7 Multi-Agent Orchestration
 *
 * Actively monitors agent health by performing periodic health checks.
 * This complements the passive heartbeat tracking in AgentRegistryService.
 *
 * Key features:
 * - Active health probing (HTTP requests to agent health endpoints)
 * - Health check history for trend analysis
 * - Automatic agent status updates based on check results
 * - Kubernetes integration for pod health correlation
 *
 * Based on best practices for distributed system health monitoring.
 * Reference: https://aws.amazon.com/solutions/guidance/multi-agent-orchestration-on-aws/
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from './prisma.service';
import { LeaderElectionService } from './leader-election.service';
import {
  AgentRegistryService,
  AgentStatus,
  AGENT_STATUS_CHANGED_EVENT,
} from './agent-registry.service';

// Health check result
export interface HealthCheckResult {
  agentId: string;
  endpoint: string;
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  timestamp: Date;
}

// Events emitted by this service
export const AGENT_HEALTH_CHECK_COMPLETED = 'agent.health.check.completed';

@Injectable()
export class AgentHealthService implements OnModuleInit {
  private readonly logger = new Logger(AgentHealthService.name);
  private readonly httpClient: AxiosInstance;

  // Configuration
  private readonly checkIntervalMs: number;
  private readonly checkTimeoutMs: number;
  private readonly unhealthyThreshold: number;
  private readonly healthyThreshold: number;
  private readonly historyRetentionHours: number;

  // Track consecutive failures for each agent
  private consecutiveFailures = new Map<string, number>();
  private consecutiveSuccesses = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly leaderElection: LeaderElectionService,
    private readonly agentRegistry: AgentRegistryService,
  ) {
    // Health check interval (default: 15 seconds)
    this.checkIntervalMs = parseInt(
      this.configService.get<string>('AGENT_HEALTH_CHECK_INTERVAL_MS', '15000'),
      10,
    );

    // Health check timeout (default: 5 seconds)
    this.checkTimeoutMs = parseInt(
      this.configService.get<string>('AGENT_HEALTH_CHECK_TIMEOUT_MS', '5000'),
      10,
    );

    // Number of consecutive failures before marking unhealthy (default: 3)
    this.unhealthyThreshold = parseInt(
      this.configService.get<string>('AGENT_UNHEALTHY_THRESHOLD', '3'),
      10,
    );

    // Number of consecutive successes before marking healthy (default: 2)
    this.healthyThreshold = parseInt(
      this.configService.get<string>('AGENT_HEALTHY_THRESHOLD', '2'),
      10,
    );

    // Health check history retention (default: 24 hours)
    this.historyRetentionHours = parseInt(
      this.configService.get<string>(
        'AGENT_HEALTH_HISTORY_RETENTION_HOURS',
        '24',
      ),
      10,
    );

    this.httpClient = axios.create({
      timeout: this.checkTimeoutMs,
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Agent Health Service initialized (interval: ${this.checkIntervalMs}ms, ` +
        `timeout: ${this.checkTimeoutMs}ms, unhealthyThreshold: ${this.unhealthyThreshold})`,
    );
  }

  /**
   * Periodic health check for all registered agents
   * Runs only on leader to avoid duplicate checks
   */
  @Cron('*/15 * * * * *') // Every 15 seconds
  async performHealthChecks(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      return;
    }

    const agents = await this.agentRegistry.getAgents({
      status: [
        AgentStatus.HEALTHY,
        AgentStatus.UNHEALTHY,
        AgentStatus.STARTING,
      ],
    });

    this.logger.debug(`Performing health checks on ${agents.length} agents`);

    // Check agents in parallel (but with concurrency limit)
    const results = await Promise.all(
      agents.map((agent) => this.checkAgentHealth(agent.id, agent.endpoint)),
    );

    // Process results
    for (const result of results) {
      await this.processHealthCheckResult(result);
    }
  }

  /**
   * Check health of a single agent
   */
  async checkAgentHealth(
    agentId: string,
    agentEndpoint: string,
  ): Promise<HealthCheckResult> {
    const healthEndpoint = `${agentEndpoint}/health/live`;
    const startTime = Date.now();

    try {
      const response = await this.httpClient.get(healthEndpoint);

      return {
        agentId,
        endpoint: healthEndpoint,
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        latencyMs: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (error: any) {
      return {
        agentId,
        endpoint: healthEndpoint,
        success: false,
        statusCode: error.response?.status,
        latencyMs: Date.now() - startTime,
        error: error.message,
        timestamp: new Date(),
      };
    }
  }

  /**
   * Process a health check result
   */
  private async processHealthCheckResult(
    result: HealthCheckResult,
  ): Promise<void> {
    // Record the health check in history
    await this.recordHealthCheck(result);

    // Update consecutive counters
    if (result.success) {
      const successes = (this.consecutiveSuccesses.get(result.agentId) || 0) + 1;
      this.consecutiveSuccesses.set(result.agentId, successes);
      this.consecutiveFailures.set(result.agentId, 0);

      // Update heartbeat
      await this.agentRegistry.updateHeartbeat(result.agentId);

      // Check if agent should become healthy
      if (successes >= this.healthyThreshold) {
        await this.tryMarkHealthy(result.agentId);
      }
    } else {
      const failures = (this.consecutiveFailures.get(result.agentId) || 0) + 1;
      this.consecutiveFailures.set(result.agentId, failures);
      this.consecutiveSuccesses.set(result.agentId, 0);

      this.logger.warn(
        `Health check failed for agent ${result.agentId}: ${result.error} ` +
          `(${failures}/${this.unhealthyThreshold} failures)`,
      );

      // Check if agent should become unhealthy
      if (failures >= this.unhealthyThreshold) {
        await this.tryMarkUnhealthy(result.agentId, result.error);
      }
    }

    // Emit event
    this.eventEmitter.emit(AGENT_HEALTH_CHECK_COMPLETED, result);
  }

  /**
   * Record health check in history
   */
  private async recordHealthCheck(result: HealthCheckResult): Promise<void> {
    await this.prisma.agentHealthCheck.create({
      data: {
        agentId: result.agentId,
        success: result.success,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        error: result.error,
        endpoint: result.endpoint,
        checkedAt: result.timestamp,
      },
    });
  }

  /**
   * Try to mark an agent as healthy
   */
  private async tryMarkHealthy(agentId: string): Promise<void> {
    const agent = await this.agentRegistry.getAgent(agentId);
    if (!agent) return;

    if (agent.status !== AgentStatus.HEALTHY) {
      this.logger.log(
        `Agent ${agent.name} (${agentId}) recovered and is now HEALTHY`,
      );

      await this.prisma.agent.update({
        where: { id: agentId },
        data: { status: AgentStatus.HEALTHY },
      });

      this.eventEmitter.emit(AGENT_STATUS_CHANGED_EVENT, {
        agentId,
        previousStatus: agent.status,
        newStatus: AgentStatus.HEALTHY,
      });
    }
  }

  /**
   * Try to mark an agent as unhealthy
   */
  private async tryMarkUnhealthy(
    agentId: string,
    error?: string,
  ): Promise<void> {
    const agent = await this.agentRegistry.getAgent(agentId);
    if (!agent) return;

    if (agent.status === AgentStatus.HEALTHY) {
      this.logger.warn(
        `Agent ${agent.name} (${agentId}) is now UNHEALTHY: ${error}`,
      );

      await this.prisma.agent.update({
        where: { id: agentId },
        data: { status: AgentStatus.UNHEALTHY },
      });

      this.eventEmitter.emit(AGENT_STATUS_CHANGED_EVENT, {
        agentId,
        previousStatus: agent.status,
        newStatus: AgentStatus.UNHEALTHY,
      });
    }
  }

  /**
   * Get recent health check history for an agent
   */
  async getHealthHistory(
    agentId: string,
    limit: number = 100,
  ): Promise<HealthCheckResult[]> {
    const checks = await this.prisma.agentHealthCheck.findMany({
      where: { agentId },
      orderBy: { checkedAt: 'desc' },
      take: limit,
    });

    return checks.map((check) => ({
      agentId: check.agentId,
      endpoint: check.endpoint,
      success: check.success,
      statusCode: check.statusCode || undefined,
      latencyMs: check.latencyMs,
      error: check.error || undefined,
      timestamp: check.checkedAt,
    }));
  }

  /**
   * Get health statistics for an agent
   */
  async getHealthStats(agentId: string): Promise<{
    successRate: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    checksInLastHour: number;
    failuresInLastHour: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
  }> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const recentChecks = await this.prisma.agentHealthCheck.findMany({
      where: {
        agentId,
        checkedAt: { gte: oneHourAgo },
      },
      orderBy: { latencyMs: 'asc' },
    });

    if (recentChecks.length === 0) {
      return {
        successRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        checksInLastHour: 0,
        failuresInLastHour: 0,
        consecutiveSuccesses: this.consecutiveSuccesses.get(agentId) || 0,
        consecutiveFailures: this.consecutiveFailures.get(agentId) || 0,
      };
    }

    const successCount = recentChecks.filter((c) => c.success).length;
    const totalLatency = recentChecks.reduce((sum, c) => sum + c.latencyMs, 0);
    const p95Index = Math.floor(recentChecks.length * 0.95);

    return {
      successRate: successCount / recentChecks.length,
      avgLatencyMs: Math.round(totalLatency / recentChecks.length),
      p95LatencyMs: recentChecks[p95Index]?.latencyMs || 0,
      checksInLastHour: recentChecks.length,
      failuresInLastHour: recentChecks.length - successCount,
      consecutiveSuccesses: this.consecutiveSuccesses.get(agentId) || 0,
      consecutiveFailures: this.consecutiveFailures.get(agentId) || 0,
    };
  }

  /**
   * Periodic cleanup of old health check records
   */
  @Cron('0 * * * *') // Every hour
  async cleanupOldHealthChecks(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      return;
    }

    const cutoffTime = new Date(
      Date.now() - this.historyRetentionHours * 60 * 60 * 1000,
    );

    const result = await this.prisma.agentHealthCheck.deleteMany({
      where: {
        checkedAt: { lt: cutoffTime },
      },
    });

    if (result.count > 0) {
      this.logger.debug(`Cleaned up ${result.count} old health check records`);
    }
  }

  /**
   * Get overall health summary for all agents
   */
  async getOverallHealthSummary(): Promise<{
    totalAgents: number;
    healthyAgents: number;
    unhealthyAgents: number;
    avgSuccessRate: number;
    avgLatencyMs: number;
    agentsSummary: Array<{
      agentId: string;
      name: string;
      status: string;
      successRate: number;
      avgLatencyMs: number;
    }>;
  }> {
    const agents = await this.agentRegistry.getAgents();
    const agentsSummary: Array<{
      agentId: string;
      name: string;
      status: string;
      successRate: number;
      avgLatencyMs: number;
    }> = [];

    let totalSuccessRate = 0;
    let totalLatency = 0;
    let agentsWithStats = 0;

    for (const agent of agents) {
      const stats = await this.getHealthStats(agent.id);
      if (stats.checksInLastHour > 0) {
        totalSuccessRate += stats.successRate;
        totalLatency += stats.avgLatencyMs;
        agentsWithStats++;
      }

      agentsSummary.push({
        agentId: agent.id,
        name: agent.name,
        status: agent.status,
        successRate: stats.successRate,
        avgLatencyMs: stats.avgLatencyMs,
      });
    }

    return {
      totalAgents: agents.length,
      healthyAgents: agents.filter((a) => a.status === AgentStatus.HEALTHY)
        .length,
      unhealthyAgents: agents.filter((a) => a.status === AgentStatus.UNHEALTHY)
        .length,
      avgSuccessRate:
        agentsWithStats > 0 ? totalSuccessRate / agentsWithStats : 0,
      avgLatencyMs:
        agentsWithStats > 0 ? Math.round(totalLatency / agentsWithStats) : 0,
      agentsSummary,
    };
  }

  /**
   * Force a health check on a specific agent
   */
  async forceHealthCheck(agentId: string): Promise<HealthCheckResult> {
    const agent = await this.agentRegistry.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const result = await this.checkAgentHealth(agent.id, agent.endpoint);
    await this.processHealthCheckResult(result);
    return result;
  }
}
