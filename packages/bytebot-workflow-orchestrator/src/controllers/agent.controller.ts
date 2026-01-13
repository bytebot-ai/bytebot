/**
 * Agent Controller
 * v1.0.0: Phase 7 Multi-Agent Orchestration
 *
 * REST API endpoints for managing agents in the multi-agent orchestration system.
 * Provides endpoints for:
 * - Agent registration and deregistration
 * - Agent health and status
 * - Agent discovery and listing
 * - Task assignment tracking
 *
 * Security: These endpoints should be protected by internal auth in production.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  AgentRegistryService,
  AgentInfo,
  AgentStatus,
  RegisterAgentInput,
} from '../services/agent-registry.service';
import { AgentRouterService } from '../services/agent-router.service';
import { AgentHealthService } from '../services/agent-health.service';

// DTOs
interface RegisterAgentDto {
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

interface HeartbeatDto {
  currentTaskCount?: number;
}

@Controller('agents')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentRegistry: AgentRegistryService,
    private readonly agentRouter: AgentRouterService,
    private readonly agentHealth: AgentHealthService,
  ) {}

  /**
   * Register a new agent or update existing
   * POST /api/v1/agents
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async registerAgent(@Body() dto: RegisterAgentDto): Promise<{
    success: boolean;
    agent: AgentInfo;
  }> {
    this.logger.log(`Registering agent: ${dto.name} at ${dto.endpoint}`);

    const agent = await this.agentRegistry.registerAgent(dto as RegisterAgentInput);

    return {
      success: true,
      agent,
    };
  }

  /**
   * List all agents with optional filtering
   * GET /api/v1/agents
   */
  @Get()
  async listAgents(
    @Query('status') status?: string,
    @Query('namespace') namespace?: string,
    @Query('hasCapacity') hasCapacity?: string,
  ): Promise<{
    success: boolean;
    agents: AgentInfo[];
    count: number;
  }> {
    const filters: {
      status?: AgentStatus | AgentStatus[];
      namespace?: string;
      hasCapacity?: boolean;
    } = {};

    if (status) {
      if (status.includes(',')) {
        filters.status = status.split(',') as AgentStatus[];
      } else {
        filters.status = status as AgentStatus;
      }
    }

    if (namespace) {
      filters.namespace = namespace;
    }

    if (hasCapacity === 'true') {
      filters.hasCapacity = true;
    }

    const agents = await this.agentRegistry.getAgents(filters);

    return {
      success: true,
      agents,
      count: agents.length,
    };
  }

  /**
   * Get available agents (healthy with capacity)
   * GET /api/v1/agents/available
   */
  @Get('available')
  async getAvailableAgents(): Promise<{
    success: boolean;
    agents: AgentInfo[];
    count: number;
  }> {
    const agents = await this.agentRegistry.getAvailableAgents();

    return {
      success: true,
      agents,
      count: agents.length,
    };
  }

  /**
   * Get agent registry statistics
   * GET /api/v1/agents/stats
   */
  @Get('stats')
  async getStats(): Promise<{
    success: boolean;
    stats: {
      total: number;
      healthy: number;
      unhealthy: number;
      draining: number;
      offline: number;
      totalCapacity: number;
      usedCapacity: number;
      utilizationPercent: number;
    };
  }> {
    const stats = await this.agentRegistry.getStats();

    return {
      success: true,
      stats,
    };
  }

  /**
   * Get routing statistics
   * GET /api/v1/agents/routing/stats
   */
  @Get('routing/stats')
  async getRoutingStats(): Promise<{
    success: boolean;
    stats: {
      totalAssignments: number;
      completedAssignments: number;
      failedAssignments: number;
      reassignments: number;
      avgCompletionTimeMs: number;
      routingReasons: Record<string, number>;
    };
  }> {
    const stats = await this.agentRouter.getStats();

    return {
      success: true,
      stats,
    };
  }

  /**
   * Get overall health summary
   * GET /api/v1/agents/health/summary
   */
  @Get('health/summary')
  async getHealthSummary(): Promise<{
    success: boolean;
    summary: {
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
    };
  }> {
    const summary = await this.agentHealth.getOverallHealthSummary();

    return {
      success: true,
      summary,
    };
  }

  /**
   * Get a specific agent by ID
   * GET /api/v1/agents/:agentId
   */
  @Get(':agentId')
  async getAgent(@Param('agentId') agentId: string): Promise<{
    success: boolean;
    agent: AgentInfo | null;
  }> {
    const agent = await this.agentRegistry.getAgent(agentId);

    return {
      success: agent !== null,
      agent,
    };
  }

  /**
   * Update agent heartbeat
   * POST /api/v1/agents/:agentId/heartbeat
   */
  @Post(':agentId/heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(
    @Param('agentId') agentId: string,
    @Body() dto: HeartbeatDto,
  ): Promise<{
    success: boolean;
  }> {
    await this.agentRegistry.updateHeartbeat(agentId, dto.currentTaskCount);

    return {
      success: true,
    };
  }

  /**
   * Get agent health statistics
   * GET /api/v1/agents/:agentId/health
   */
  @Get(':agentId/health')
  async getAgentHealth(@Param('agentId') agentId: string): Promise<{
    success: boolean;
    health: {
      successRate: number;
      avgLatencyMs: number;
      p95LatencyMs: number;
      checksInLastHour: number;
      failuresInLastHour: number;
      consecutiveSuccesses: number;
      consecutiveFailures: number;
    };
  }> {
    const health = await this.agentHealth.getHealthStats(agentId);

    return {
      success: true,
      health,
    };
  }

  /**
   * Get agent health check history
   * GET /api/v1/agents/:agentId/health/history
   */
  @Get(':agentId/health/history')
  async getAgentHealthHistory(
    @Param('agentId') agentId: string,
    @Query('limit') limit?: string,
  ): Promise<{
    success: boolean;
    history: Array<{
      agentId: string;
      endpoint: string;
      success: boolean;
      statusCode?: number;
      latencyMs: number;
      error?: string;
      timestamp: Date;
    }>;
  }> {
    const parsedLimit = limit ? parseInt(limit, 10) : 100;
    const history = await this.agentHealth.getHealthHistory(agentId, parsedLimit);

    return {
      success: true,
      history,
    };
  }

  /**
   * Force a health check on a specific agent
   * POST /api/v1/agents/:agentId/health/check
   */
  @Post(':agentId/health/check')
  @HttpCode(HttpStatus.OK)
  async forceHealthCheck(@Param('agentId') agentId: string): Promise<{
    success: boolean;
    result: {
      agentId: string;
      endpoint: string;
      success: boolean;
      statusCode?: number;
      latencyMs: number;
      error?: string;
      timestamp: Date;
    };
  }> {
    const result = await this.agentHealth.forceHealthCheck(agentId);

    return {
      success: true,
      result,
    };
  }

  /**
   * Mark agent as draining (no new tasks)
   * POST /api/v1/agents/:agentId/drain
   */
  @Post(':agentId/drain')
  @HttpCode(HttpStatus.OK)
  async drainAgent(@Param('agentId') agentId: string): Promise<{
    success: boolean;
  }> {
    await this.agentRegistry.drainAgent(agentId);

    return {
      success: true,
    };
  }

  /**
   * Deregister an agent
   * DELETE /api/v1/agents/:agentId
   */
  @Delete(':agentId')
  @HttpCode(HttpStatus.OK)
  async deregisterAgent(@Param('agentId') agentId: string): Promise<{
    success: boolean;
  }> {
    await this.agentRegistry.deregisterAgent(agentId);

    return {
      success: true,
    };
  }
}
