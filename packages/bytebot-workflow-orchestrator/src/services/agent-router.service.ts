/**
 * Agent Router Service
 * v1.0.0: Phase 7 Multi-Agent Orchestration
 *
 * Implements intelligent task routing to select the best agent for each task.
 * Uses multiple routing strategies:
 * - Capability-based routing (match tools to agent capabilities)
 * - Load-balanced routing (distribute work evenly)
 * - Affinity routing (prefer agents that handled related tasks)
 * - Cost-aware routing (consider cost multipliers)
 *
 * Based on the Supervisor pattern from multi-agent orchestration best practices.
 * Reference: https://blog.langchain.com/langgraph-multi-agent-workflows/
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import {
  AgentRegistryService,
  AgentInfo,
  AgentStatus,
} from './agent-registry.service';
import { minimatch } from 'minimatch';

// Routing strategies
export enum RoutingStrategy {
  ROUND_ROBIN = 'round_robin',
  LEAST_LOADED = 'least_loaded',
  CAPABILITY_MATCH = 'capability_match',
  WEIGHTED = 'weighted',
  AFFINITY = 'affinity',
}

// Routing result
export interface RoutingResult {
  agent: AgentInfo;
  reason: string;
  score: number;
  alternativeAgents: Array<{ agent: AgentInfo; score: number }>;
}

// Task routing request
export interface RoutingRequest {
  nodeId: string;
  workflowId: string;
  workspaceId: string;
  requiredTools: string[];
  preferredAgentId?: string;
  affinityNodeIds?: string[];
  requiresExclusiveWorkspace?: boolean;
  maxCost?: number;
}

@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);
  private roundRobinIndex = 0;
  private readonly defaultStrategy: RoutingStrategy;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly agentRegistry: AgentRegistryService,
  ) {
    this.defaultStrategy = this.configService.get<RoutingStrategy>(
      'AGENT_ROUTING_STRATEGY',
      RoutingStrategy.CAPABILITY_MATCH,
    );
  }

  /**
   * Route a task to the best available agent
   *
   * This is the main entry point for task routing.
   * It evaluates all available agents and selects the best one based on:
   * 1. Capability matching (can the agent handle the required tools?)
   * 2. Availability (is the agent healthy and has capacity?)
   * 3. Load balancing (distribute work evenly across agents)
   * 4. Affinity (prefer agents that handled related tasks)
   * 5. Cost (consider cost multipliers if specified)
   */
  async routeTask(request: RoutingRequest): Promise<RoutingResult | null> {
    this.logger.debug(`Routing task for node ${request.nodeId}`);

    // Get all available agents
    const agents = await this.agentRegistry.getAvailableAgents();

    if (agents.length === 0) {
      this.logger.warn('No available agents for task routing');
      return null;
    }

    // If preferred agent is specified and available, use it
    if (request.preferredAgentId) {
      const preferredAgent = agents.find(
        (a) => a.id === request.preferredAgentId,
      );
      if (preferredAgent) {
        return {
          agent: preferredAgent,
          reason: 'preferred_agent',
          score: 1.0,
          alternativeAgents: [],
        };
      }
    }

    // Score each agent
    const scoredAgents = await Promise.all(
      agents.map(async (agent) => {
        const score = await this.scoreAgent(agent, request);
        return { agent, score };
      }),
    );

    // Filter out agents that can't handle the task (score = 0)
    const eligibleAgents = scoredAgents.filter((sa) => sa.score > 0);

    if (eligibleAgents.length === 0) {
      this.logger.warn(
        `No agents capable of handling task with tools: ${request.requiredTools.join(', ')}`,
      );
      return null;
    }

    // Sort by score (descending)
    eligibleAgents.sort((a, b) => b.score - a.score);

    const selectedAgent = eligibleAgents[0];
    const alternativeAgents = eligibleAgents.slice(1, 4); // Top 3 alternatives

    this.logger.log(
      `Routed task ${request.nodeId} to agent ${selectedAgent.agent.name} ` +
        `(score: ${selectedAgent.score.toFixed(2)}, reason: capability_match)`,
    );

    return {
      agent: selectedAgent.agent,
      reason: this.determineReason(selectedAgent, request),
      score: selectedAgent.score,
      alternativeAgents,
    };
  }

  /**
   * Score an agent for a given task
   *
   * Returns a score from 0.0 (cannot handle) to 1.0 (perfect match)
   */
  private async scoreAgent(
    agent: AgentInfo,
    request: RoutingRequest,
  ): Promise<number> {
    let score = 1.0;

    // 1. Capability matching (most important)
    const capabilityScore = this.scoreCapabilities(
      agent,
      request.requiredTools,
    );
    if (capabilityScore === 0) {
      return 0; // Agent cannot handle required tools
    }
    score *= capabilityScore;

    // 2. Load factor (prefer less loaded agents)
    const loadScore = this.scoreLoad(agent);
    score *= loadScore;

    // 3. Weight factor (agent-level priority)
    const weightScore = agent.weight / 100;
    score *= weightScore;

    // 4. Affinity bonus (prefer agents that handled related tasks)
    if (request.affinityNodeIds && request.affinityNodeIds.length > 0) {
      const affinityScore = await this.scoreAffinity(
        agent,
        request.affinityNodeIds,
      );
      score *= 1 + affinityScore * 0.2; // Up to 20% bonus
    }

    // 5. Cost consideration
    if (request.maxCost !== undefined) {
      const costScore = this.scoreCost(agent, request.requiredTools);
      if (costScore === 0) {
        return 0; // Agent is too expensive
      }
      score *= costScore;
    }

    // 6. Exclusive workspace check
    if (request.requiresExclusiveWorkspace) {
      const hasExclusiveCapability = agent.capabilities.some(
        (cap) =>
          cap.requiresExclusiveWorkspace &&
          this.matchesTools(cap.toolPattern, request.requiredTools),
      );
      if (!hasExclusiveCapability) {
        return 0;
      }
    }

    return Math.min(score, 1.0);
  }

  /**
   * Score agent capabilities against required tools
   */
  private scoreCapabilities(
    agent: AgentInfo,
    requiredTools: string[],
  ): number {
    if (requiredTools.length === 0) {
      return 1.0; // No specific tools required
    }

    // Check if agent can handle all required tools
    let matchedCount = 0;
    let totalPriority = 0;

    for (const tool of requiredTools) {
      const matchingCapability = agent.capabilities.find((cap) =>
        this.matchTool(tool, cap.toolPattern),
      );

      if (matchingCapability) {
        matchedCount++;
        totalPriority += matchingCapability.priority;
      }
    }

    if (matchedCount < requiredTools.length) {
      return 0; // Cannot handle all required tools
    }

    // Score based on capability priority
    const avgPriority = totalPriority / requiredTools.length;
    return avgPriority / 100; // Normalize to 0-1
  }

  /**
   * Score agent load (prefer less loaded agents)
   */
  private scoreLoad(agent: AgentInfo): number {
    if (agent.maxConcurrentTasks === 0) {
      return 0;
    }

    const utilization = agent.currentTaskCount / agent.maxConcurrentTasks;
    // Exponential decay: heavily penalize near-capacity agents
    return Math.exp(-2 * utilization);
  }

  /**
   * Score affinity (preference for agents that handled related tasks)
   */
  private async scoreAffinity(
    agent: AgentInfo,
    affinityNodeIds: string[],
  ): Promise<number> {
    // Check how many of the affinity nodes were handled by this agent
    const assignments = await this.prisma.taskAssignment.findMany({
      where: {
        nodeRunId: { in: affinityNodeIds },
        agentId: agent.id,
        status: { in: ['COMPLETED', 'RUNNING'] },
      },
    });

    return assignments.length / affinityNodeIds.length;
  }

  /**
   * Score cost (prefer lower cost agents)
   */
  private scoreCost(agent: AgentInfo, requiredTools: string[]): number {
    let totalCost = 0;

    for (const tool of requiredTools) {
      const matchingCapability = agent.capabilities.find((cap) =>
        this.matchTool(tool, cap.toolPattern),
      );

      if (matchingCapability) {
        totalCost += matchingCapability.costMultiplier;
      } else {
        totalCost += 1.0; // Default cost
      }
    }

    const avgCost = totalCost / Math.max(requiredTools.length, 1);
    // Inverse: lower cost = higher score
    return 1 / avgCost;
  }

  /**
   * Match a tool against a pattern (glob-style)
   */
  private matchTool(tool: string, pattern: string): boolean {
    if (pattern === '*') {
      return true;
    }
    return minimatch(tool, pattern);
  }

  /**
   * Check if any required tools match the pattern
   */
  private matchesTools(pattern: string, tools: string[]): boolean {
    if (pattern === '*') {
      return true;
    }
    return tools.some((tool) => minimatch(tool, pattern));
  }

  /**
   * Determine the primary routing reason
   */
  private determineReason(
    selectedAgent: { agent: AgentInfo; score: number },
    request: RoutingRequest,
  ): string {
    if (request.preferredAgentId === selectedAgent.agent.id) {
      return 'preferred_agent';
    }
    if (request.affinityNodeIds && request.affinityNodeIds.length > 0) {
      return 'affinity';
    }
    if (request.requiredTools.length > 0) {
      return 'capability_match';
    }
    return 'load_balance';
  }

  /**
   * Simple round-robin routing (fallback)
   */
  async routeRoundRobin(): Promise<AgentInfo | null> {
    const agents = await this.agentRegistry.getAvailableAgents();
    if (agents.length === 0) {
      return null;
    }

    const agent = agents[this.roundRobinIndex % agents.length];
    this.roundRobinIndex++;

    return agent;
  }

  /**
   * Get agent with least current load
   */
  async routeLeastLoaded(): Promise<AgentInfo | null> {
    const agents = await this.agentRegistry.getAvailableAgents();
    if (agents.length === 0) {
      return null;
    }

    // Sort by utilization (ascending)
    agents.sort((a, b) => {
      const utilizationA = a.currentTaskCount / a.maxConcurrentTasks;
      const utilizationB = b.currentTaskCount / b.maxConcurrentTasks;
      return utilizationA - utilizationB;
    });

    return agents[0];
  }

  /**
   * Record a task assignment
   */
  async recordAssignment(
    nodeRunId: string,
    agentId: string,
    routingReason: string,
  ): Promise<void> {
    // Get the attempt number
    const existingAssignments = await this.prisma.taskAssignment.count({
      where: { nodeRunId },
    });

    await this.prisma.taskAssignment.create({
      data: {
        nodeRunId,
        agentId,
        routingReason,
        status: 'ASSIGNED',
        attempt: existingAssignments + 1,
        dispatchedAt: new Date(),
      },
    });

    // Increment agent task count
    await this.agentRegistry.incrementTaskCount(agentId);
  }

  /**
   * Complete a task assignment
   */
  async completeAssignment(
    nodeRunId: string,
    agentId: string,
    success: boolean,
    result?: any,
    error?: string,
  ): Promise<void> {
    await this.prisma.taskAssignment.updateMany({
      where: {
        nodeRunId,
        agentId,
        status: { in: ['ASSIGNED', 'RUNNING'] },
      },
      data: {
        status: success ? 'COMPLETED' : 'FAILED',
        completedAt: new Date(),
        result,
        error,
      },
    });

    // Decrement agent task count
    await this.agentRegistry.decrementTaskCount(agentId);
  }

  /**
   * Reassign a task to a different agent
   */
  async reassignTask(
    nodeRunId: string,
    fromAgentId: string,
    toAgentId: string,
    reason: string,
  ): Promise<void> {
    // Get the current assignment
    const currentAssignment = await this.prisma.taskAssignment.findFirst({
      where: {
        nodeRunId,
        agentId: fromAgentId,
        status: { in: ['ASSIGNED', 'RUNNING'] },
      },
    });

    if (currentAssignment) {
      // Mark current assignment as reassigned
      await this.prisma.taskAssignment.update({
        where: { id: currentAssignment.id },
        data: { status: 'REASSIGNED' },
      });

      // Create new assignment
      await this.prisma.taskAssignment.create({
        data: {
          nodeRunId,
          agentId: toAgentId,
          routingReason: reason,
          status: 'ASSIGNED',
          attempt: currentAssignment.attempt + 1,
          previousAssignmentId: currentAssignment.id,
          dispatchedAt: new Date(),
        },
      });

      // Update task counts
      await this.agentRegistry.decrementTaskCount(fromAgentId);
      await this.agentRegistry.incrementTaskCount(toAgentId);

      this.logger.log(
        `Reassigned task ${nodeRunId} from agent ${fromAgentId} to ${toAgentId}: ${reason}`,
      );
    }
  }

  /**
   * Get routing statistics for monitoring
   */
  async getStats(): Promise<{
    totalAssignments: number;
    completedAssignments: number;
    failedAssignments: number;
    reassignments: number;
    avgCompletionTimeMs: number;
    routingReasons: Record<string, number>;
  }> {
    const assignments = await this.prisma.taskAssignment.findMany({
      select: {
        status: true,
        routingReason: true,
        dispatchedAt: true,
        completedAt: true,
      },
    });

    const stats = {
      totalAssignments: assignments.length,
      completedAssignments: 0,
      failedAssignments: 0,
      reassignments: 0,
      avgCompletionTimeMs: 0,
      routingReasons: {} as Record<string, number>,
    };

    let totalCompletionTime = 0;
    let completionCount = 0;

    for (const assignment of assignments) {
      switch (assignment.status) {
        case 'COMPLETED':
          stats.completedAssignments++;
          if (assignment.dispatchedAt && assignment.completedAt) {
            totalCompletionTime +=
              assignment.completedAt.getTime() -
              assignment.dispatchedAt.getTime();
            completionCount++;
          }
          break;
        case 'FAILED':
          stats.failedAssignments++;
          break;
        case 'REASSIGNED':
          stats.reassignments++;
          break;
      }

      // Count routing reasons
      const reason = assignment.routingReason || 'unknown';
      stats.routingReasons[reason] = (stats.routingReasons[reason] || 0) + 1;
    }

    if (completionCount > 0) {
      stats.avgCompletionTimeMs = Math.round(
        totalCompletionTime / completionCount,
      );
    }

    return stats;
  }
}
