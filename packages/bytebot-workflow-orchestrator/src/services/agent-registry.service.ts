/**
 * Agent Registry Service
 * v1.0.0: Phase 7 Multi-Agent Orchestration
 *
 * Manages registration, discovery, and lifecycle of agent instances.
 * Implements the Supervisor pattern where the orchestrator acts as a
 * central coordinator for multiple worker agents.
 *
 * Key features:
 * - Agent registration and deregistration
 * - Agent discovery by status, capability, and availability
 * - Heartbeat tracking for health monitoring
 * - Capacity management (max concurrent tasks per agent)
 * - Kubernetes pod discovery integration
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { LeaderElectionService } from './leader-election.service';

// Agent status enum
export enum AgentStatus {
  STARTING = 'STARTING',
  HEALTHY = 'HEALTHY',
  UNHEALTHY = 'UNHEALTHY',
  DRAINING = 'DRAINING', // No new tasks, completing existing
  OFFLINE = 'OFFLINE',
}

// Events emitted by this service
export const AGENT_REGISTERED_EVENT = 'agent.registered';
export const AGENT_DEREGISTERED_EVENT = 'agent.deregistered';
export const AGENT_STATUS_CHANGED_EVENT = 'agent.status.changed';
export const AGENT_UNHEALTHY_EVENT = 'agent.unhealthy';

export interface AgentInfo {
  id: string;
  name: string;
  endpoint: string;
  podName?: string;
  nodeIp?: string;
  namespace: string;
  status: AgentStatus;
  lastHeartbeatAt: Date;
  maxConcurrentTasks: number;
  currentTaskCount: number;
  weight: number;
  version: string;
  metadata: Record<string, any>;
  capabilities: AgentCapabilityInfo[];
}

export interface AgentCapabilityInfo {
  name: string;
  toolPattern: string;
  priority: number;
  costMultiplier: number;
  requiresExclusiveWorkspace: boolean;
}

export interface RegisterAgentInput {
  name: string;
  endpoint: string;
  podName?: string;
  nodeIp?: string;
  namespace?: string;
  maxConcurrentTasks?: number;
  weight?: number;
  version?: string;
  metadata?: Record<string, any>;
  capabilities?: Array<{
    name: string;
    toolPattern: string;
    priority?: number;
    costMultiplier?: number;
    requiresExclusiveWorkspace?: boolean;
  }>;
}

@Injectable()
export class AgentRegistryService implements OnModuleInit {
  private readonly logger = new Logger(AgentRegistryService.name);

  // Configuration
  private readonly heartbeatTimeoutMs: number;
  private readonly staleAgentTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly leaderElection: LeaderElectionService,
  ) {
    // Heartbeat timeout: how long before an agent is marked unhealthy
    this.heartbeatTimeoutMs = parseInt(
      this.configService.get<string>('AGENT_HEARTBEAT_TIMEOUT_MS', '30000'),
      10,
    );

    // Stale agent timeout: how long before an offline agent is removed
    this.staleAgentTimeoutMs = parseInt(
      this.configService.get<string>('AGENT_STALE_TIMEOUT_MS', '3600000'), // 1 hour
      10,
    );
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Agent Registry Service initialized');

    // Bootstrap with default agent if configured (for backward compatibility)
    const defaultAgentUrl = this.configService.get<string>('AGENT_SERVICE_URL');
    if (defaultAgentUrl) {
      await this.ensureDefaultAgent(defaultAgentUrl);
    }
  }

  /**
   * Ensure a default agent exists (backward compatibility with single-agent mode)
   */
  private async ensureDefaultAgent(endpoint: string): Promise<void> {
    const existing = await this.prisma.agent.findUnique({
      where: { endpoint },
    });

    if (!existing) {
      this.logger.log(`Registering default agent at ${endpoint}`);
      await this.registerAgent({
        name: 'default-agent',
        endpoint,
        capabilities: [
          {
            name: 'all',
            toolPattern: '*',
            priority: 100,
          },
        ],
      });
    }
  }

  /**
   * Register a new agent or update existing agent
   */
  async registerAgent(input: RegisterAgentInput): Promise<AgentInfo> {
    const {
      name,
      endpoint,
      podName,
      nodeIp,
      namespace = 'bytebot',
      maxConcurrentTasks = 3,
      weight = 100,
      version = '1.0.0',
      metadata = {},
      capabilities = [],
    } = input;

    this.logger.log(`Registering agent: ${name} at ${endpoint}`);

    // Upsert agent
    const agent = await this.prisma.agent.upsert({
      where: { endpoint },
      create: {
        name,
        endpoint,
        podName,
        nodeIp,
        namespace,
        maxConcurrentTasks,
        weight,
        version,
        metadata,
        status: AgentStatus.STARTING,
        lastHeartbeatAt: new Date(),
      },
      update: {
        name,
        podName,
        nodeIp,
        namespace,
        maxConcurrentTasks,
        weight,
        version,
        metadata,
        status: AgentStatus.HEALTHY,
        lastHeartbeatAt: new Date(),
      },
      include: {
        capabilities: true,
      },
    });

    // Update capabilities (delete and recreate for simplicity)
    await this.prisma.agentCapability.deleteMany({
      where: { agentId: agent.id },
    });

    if (capabilities.length > 0) {
      await this.prisma.agentCapability.createMany({
        data: capabilities.map((cap) => ({
          agentId: agent.id,
          name: cap.name,
          toolPattern: cap.toolPattern,
          priority: cap.priority ?? 100,
          costMultiplier: cap.costMultiplier ?? 1.0,
          requiresExclusiveWorkspace: cap.requiresExclusiveWorkspace ?? false,
        })),
      });
    }

    // Fetch updated agent with capabilities
    const updatedAgent = await this.prisma.agent.findUnique({
      where: { id: agent.id },
      include: { capabilities: true },
    });

    const agentInfo = this.toAgentInfo(updatedAgent!);

    this.eventEmitter.emit(AGENT_REGISTERED_EVENT, {
      agentId: agent.id,
      name,
      endpoint,
    });

    this.logger.log(`Agent registered: ${name} (${agent.id})`);

    return agentInfo;
  }

  /**
   * Deregister an agent (mark as offline)
   */
  async deregisterAgent(agentId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });

    if (!agent) {
      this.logger.warn(`Agent not found for deregistration: ${agentId}`);
      return;
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        status: AgentStatus.OFFLINE,
      },
    });

    this.eventEmitter.emit(AGENT_DEREGISTERED_EVENT, {
      agentId,
      name: agent.name,
      endpoint: agent.endpoint,
    });

    this.logger.log(`Agent deregistered: ${agent.name} (${agentId})`);
  }

  /**
   * Update agent heartbeat (called by agent health checks)
   */
  async updateHeartbeat(
    agentId: string,
    currentTaskCount?: number,
  ): Promise<void> {
    const updateData: any = {
      lastHeartbeatAt: new Date(),
      status: AgentStatus.HEALTHY,
    };

    if (currentTaskCount !== undefined) {
      updateData.currentTaskCount = currentTaskCount;
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: updateData,
    });
  }

  /**
   * Get agent by ID
   */
  async getAgent(agentId: string): Promise<AgentInfo | null> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      include: { capabilities: true },
    });

    return agent ? this.toAgentInfo(agent) : null;
  }

  /**
   * Get agent by endpoint
   */
  async getAgentByEndpoint(endpoint: string): Promise<AgentInfo | null> {
    const agent = await this.prisma.agent.findUnique({
      where: { endpoint },
      include: { capabilities: true },
    });

    return agent ? this.toAgentInfo(agent) : null;
  }

  /**
   * Get all agents with optional filtering
   */
  async getAgents(filters?: {
    status?: AgentStatus | AgentStatus[];
    namespace?: string;
    hasCapacity?: boolean;
  }): Promise<AgentInfo[]> {
    const where: any = {};

    if (filters?.status) {
      where.status = Array.isArray(filters.status)
        ? { in: filters.status }
        : filters.status;
    }

    if (filters?.namespace) {
      where.namespace = filters.namespace;
    }

    const agents = await this.prisma.agent.findMany({
      where,
      include: { capabilities: true },
      orderBy: { registeredAt: 'asc' },
    });

    let result = agents.map((a) => this.toAgentInfo(a));

    // Filter by capacity if requested
    if (filters?.hasCapacity) {
      result = result.filter((a) => a.currentTaskCount < a.maxConcurrentTasks);
    }

    return result;
  }

  /**
   * Get available agents (healthy with capacity)
   */
  async getAvailableAgents(): Promise<AgentInfo[]> {
    return this.getAgents({
      status: AgentStatus.HEALTHY,
      hasCapacity: true,
    });
  }

  /**
   * Increment task count when a task is assigned
   */
  async incrementTaskCount(agentId: string): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        currentTaskCount: { increment: 1 },
      },
    });
  }

  /**
   * Decrement task count when a task completes
   */
  async decrementTaskCount(agentId: string): Promise<void> {
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        currentTaskCount: { decrement: 1 },
      },
    });

    // Ensure task count doesn't go negative
    await this.prisma.$executeRaw`
      UPDATE workflow_orchestrator.agents
      SET current_task_count = 0
      WHERE id = ${agentId} AND current_task_count < 0
    `;
  }

  /**
   * Mark agent as draining (no new tasks)
   */
  async drainAgent(agentId: string): Promise<void> {
    const previous = await this.prisma.agent.findUnique({
      where: { id: agentId },
    });

    if (!previous) return;

    await this.prisma.agent.update({
      where: { id: agentId },
      data: { status: AgentStatus.DRAINING },
    });

    this.eventEmitter.emit(AGENT_STATUS_CHANGED_EVENT, {
      agentId,
      previousStatus: previous.status,
      newStatus: AgentStatus.DRAINING,
    });

    this.logger.log(`Agent ${agentId} is now draining`);
  }

  /**
   * Periodic health check for all agents
   * Runs only on leader to avoid duplicate checks
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async checkAgentHealth(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      return;
    }

    const cutoffTime = new Date(Date.now() - this.heartbeatTimeoutMs);

    // Find agents that haven't sent heartbeat recently
    const unhealthyAgents = await this.prisma.agent.findMany({
      where: {
        status: { in: [AgentStatus.HEALTHY, AgentStatus.STARTING] },
        lastHeartbeatAt: { lt: cutoffTime },
      },
    });

    for (const agent of unhealthyAgents) {
      this.logger.warn(
        `Agent ${agent.name} (${agent.id}) is unhealthy - no heartbeat since ${agent.lastHeartbeatAt}`,
      );

      await this.prisma.agent.update({
        where: { id: agent.id },
        data: { status: AgentStatus.UNHEALTHY },
      });

      this.eventEmitter.emit(AGENT_UNHEALTHY_EVENT, {
        agentId: agent.id,
        name: agent.name,
        lastHeartbeat: agent.lastHeartbeatAt,
      });

      this.eventEmitter.emit(AGENT_STATUS_CHANGED_EVENT, {
        agentId: agent.id,
        previousStatus: agent.status,
        newStatus: AgentStatus.UNHEALTHY,
      });
    }
  }

  /**
   * Periodic cleanup of stale agents
   * Runs only on leader
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStaleAgents(): Promise<void> {
    if (!this.leaderElection.isLeader) {
      return;
    }

    const cutoffTime = new Date(Date.now() - this.staleAgentTimeoutMs);

    // Delete agents that have been offline for too long
    const result = await this.prisma.agent.deleteMany({
      where: {
        status: AgentStatus.OFFLINE,
        updatedAt: { lt: cutoffTime },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} stale agents`);
    }
  }

  /**
   * Get registry statistics for monitoring
   */
  async getStats(): Promise<{
    total: number;
    healthy: number;
    unhealthy: number;
    draining: number;
    offline: number;
    totalCapacity: number;
    usedCapacity: number;
    utilizationPercent: number;
  }> {
    const agents = await this.prisma.agent.findMany();

    const stats = {
      total: agents.length,
      healthy: 0,
      unhealthy: 0,
      draining: 0,
      offline: 0,
      totalCapacity: 0,
      usedCapacity: 0,
      utilizationPercent: 0,
    };

    for (const agent of agents) {
      switch (agent.status) {
        case AgentStatus.HEALTHY:
          stats.healthy++;
          stats.totalCapacity += agent.maxConcurrentTasks;
          stats.usedCapacity += agent.currentTaskCount;
          break;
        case AgentStatus.UNHEALTHY:
          stats.unhealthy++;
          break;
        case AgentStatus.DRAINING:
          stats.draining++;
          stats.usedCapacity += agent.currentTaskCount;
          break;
        case AgentStatus.OFFLINE:
          stats.offline++;
          break;
      }
    }

    if (stats.totalCapacity > 0) {
      stats.utilizationPercent = Math.round(
        (stats.usedCapacity / stats.totalCapacity) * 100,
      );
    }

    return stats;
  }

  /**
   * Convert Prisma agent to AgentInfo
   */
  private toAgentInfo(agent: any): AgentInfo {
    return {
      id: agent.id,
      name: agent.name,
      endpoint: agent.endpoint,
      podName: agent.podName,
      nodeIp: agent.nodeIp,
      namespace: agent.namespace,
      status: agent.status as AgentStatus,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      maxConcurrentTasks: agent.maxConcurrentTasks,
      currentTaskCount: agent.currentTaskCount,
      weight: agent.weight,
      version: agent.version,
      metadata: agent.metadata as Record<string, any>,
      capabilities: (agent.capabilities || []).map((cap: any) => ({
        name: cap.name,
        toolPattern: cap.toolPattern,
        priority: cap.priority,
        costMultiplier: cap.costMultiplier,
        requiresExclusiveWorkspace: cap.requiresExclusiveWorkspace,
      })),
    };
  }
}
