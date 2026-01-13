/**
 * Circuit Breaker Service
 * v1.0.0: Phase 9 Self-Healing & Auto-Recovery
 * v2.0.0: Agent Routing Enhancements (v5.10.0)
 *
 * Implements resilience patterns using Cockatiel library:
 * - Circuit breaker: Prevents cascading failures
 * - Retry with exponential backoff: Handles transient failures
 * - Timeout: Prevents hanging calls
 * - Bulkhead: Isolates failures per service
 * - Agent routing: Health-aware agent selection with automatic failover
 *
 * Each external service gets its own policy chain for isolation.
 * v2.0.0 adds agent routing with health scoring and automatic failover.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import {
  CircuitBreakerPolicy,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  timeout,
  wrap,
  circuitBreaker,
  bulkhead,
  BulkheadPolicy,
  TimeoutPolicy,
  RetryPolicy,
  IPolicy,
  CircuitState,
  TimeoutStrategy,
} from 'cockatiel';

// Circuit breaker states
export enum CircuitBreakerStateEnum {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

// Service configuration
export interface ServiceConfig {
  name: string;
  // Circuit breaker settings
  failureThreshold: number;     // Failures before opening
  successThreshold: number;     // Successes in half-open to close
  resetTimeoutMs: number;       // Time before trying half-open
  // Retry settings
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  // Timeout settings
  timeoutMs: number;
  // Bulkhead settings
  maxConcurrent: number;
  maxQueue: number;
}

// Default configurations for known services
const DEFAULT_CONFIGS: Record<string, Partial<ServiceConfig>> = {
  'task-controller': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30000,
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    timeoutMs: 60000,
    maxConcurrent: 10,
    maxQueue: 50,
  },
  'agent': {
    failureThreshold: 3,
    successThreshold: 2,
    resetTimeoutMs: 15000,
    maxRetries: 2,
    initialDelayMs: 500,
    maxDelayMs: 10000,
    timeoutMs: 30000,
    maxConcurrent: 5,
    maxQueue: 20,
  },
  'default': {
    failureThreshold: 5,
    successThreshold: 3,
    resetTimeoutMs: 30000,
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    timeoutMs: 60000,
    maxConcurrent: 10,
    maxQueue: 50,
  },
};

// Combined policy for a service
interface ServicePolicy {
  config: ServiceConfig;
  circuitBreaker: CircuitBreakerPolicy;
  retry: RetryPolicy;
  timeout: TimeoutPolicy;
  bulkhead: BulkheadPolicy;
  combined: IPolicy;
  stats: {
    totalRequests: number;
    totalFailures: number;
    totalSuccesses: number;
    totalTimeouts: number;
  };
}

@Injectable()
export class CircuitBreakerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private readonly policies: Map<string, ServicePolicy> = new Map();
  private persistInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing Circuit Breaker Service');

    // Load persisted circuit breaker states
    await this.loadPersistedStates();

    // Start periodic persistence (every 30 seconds)
    this.persistInterval = setInterval(
      () => this.persistAllStates(),
      30000,
    );

    this.logger.log('Circuit Breaker Service initialized');
  }

  async onModuleDestroy() {
    // Clear persistence interval
    if (this.persistInterval) {
      clearInterval(this.persistInterval);
    }

    // Persist final states
    await this.persistAllStates();

    this.logger.log('Circuit Breaker Service destroyed');
  }

  /**
   * Get or create a policy chain for a service
   */
  getPolicy(serviceName: string): ServicePolicy {
    let policy = this.policies.get(serviceName);
    if (!policy) {
      policy = this.createPolicy(serviceName);
      this.policies.set(serviceName, policy);
    }
    return policy;
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(
    serviceName: string,
    fn: () => Promise<T>,
    context?: Record<string, any>,
  ): Promise<T> {
    const policy = this.getPolicy(serviceName);
    policy.stats.totalRequests++;

    try {
      const result = await policy.combined.execute(fn);
      policy.stats.totalSuccesses++;
      return result;
    } catch (error) {
      policy.stats.totalFailures++;

      // Check if it was a timeout
      if (error.name === 'TaskCancelledError') {
        policy.stats.totalTimeouts++;
      }

      // Emit event for monitoring
      this.eventEmitter.emit('circuit-breaker.failure', {
        serviceName,
        error: error.message,
        state: this.getCircuitState(serviceName),
        context,
      });

      throw error;
    }
  }

  /**
   * Execute with fallback on failure
   */
  async executeWithFallback<T>(
    serviceName: string,
    fn: () => Promise<T>,
    fallback: (error: Error) => T | Promise<T>,
    context?: Record<string, any>,
  ): Promise<T> {
    try {
      return await this.execute(serviceName, fn, context);
    } catch (error) {
      this.logger.warn(
        `Circuit breaker fallback triggered for ${serviceName}: ${error.message}`,
      );

      this.eventEmitter.emit('circuit-breaker.fallback', {
        serviceName,
        error: error.message,
        context,
      });

      return fallback(error);
    }
  }

  /**
   * Get current circuit state for a service
   */
  getCircuitState(serviceName: string): CircuitBreakerStateEnum {
    const policy = this.policies.get(serviceName);
    if (!policy) {
      return CircuitBreakerStateEnum.CLOSED;
    }

    const state = policy.circuitBreaker.state;
    switch (state) {
      case CircuitState.Open:
        return CircuitBreakerStateEnum.OPEN;
      case CircuitState.HalfOpen:
        return CircuitBreakerStateEnum.HALF_OPEN;
      default:
        return CircuitBreakerStateEnum.CLOSED;
    }
  }

  /**
   * Get statistics for a service
   */
  getStats(serviceName: string): {
    state: CircuitBreakerStateEnum;
    stats: ServicePolicy['stats'];
    config: ServiceConfig;
  } | null {
    const policy = this.policies.get(serviceName);
    if (!policy) {
      return null;
    }

    return {
      state: this.getCircuitState(serviceName),
      stats: { ...policy.stats },
      config: policy.config,
    };
  }

  /**
   * Get all circuit breaker statuses
   */
  getAllStats(): Array<{
    serviceName: string;
    state: CircuitBreakerStateEnum;
    stats: ServicePolicy['stats'];
  }> {
    const result: Array<{
      serviceName: string;
      state: CircuitBreakerStateEnum;
      stats: ServicePolicy['stats'];
    }> = [];

    for (const [serviceName, policy] of this.policies) {
      result.push({
        serviceName,
        state: this.getCircuitState(serviceName),
        stats: { ...policy.stats },
      });
    }

    return result;
  }

  /**
   * Manually reset a circuit breaker
   */
  async resetCircuit(serviceName: string): Promise<void> {
    const policy = this.policies.get(serviceName);
    if (policy) {
      // Cockatiel doesn't have a direct reset method, so we recreate the policy
      this.policies.delete(serviceName);
      this.policies.set(serviceName, this.createPolicy(serviceName));

      // Log recovery action
      await this.logRecoveryAction(
        serviceName,
        'CIRCUIT_RESET',
        this.getCircuitState(serviceName).toString(),
        CircuitBreakerStateEnum.CLOSED,
        'Manual circuit breaker reset',
      );

      this.logger.log(`Circuit breaker reset for ${serviceName}`);
    }
  }

  /**
   * Check if circuit is open (failing)
   */
  isCircuitOpen(serviceName: string): boolean {
    return this.getCircuitState(serviceName) === CircuitBreakerStateEnum.OPEN;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Create a policy chain for a service
   */
  private createPolicy(serviceName: string): ServicePolicy {
    const config = this.getServiceConfig(serviceName);

    // Create circuit breaker
    const cb = circuitBreaker(handleAll, {
      halfOpenAfter: config.resetTimeoutMs,
      breaker: new ConsecutiveBreaker(config.failureThreshold),
    });

    // Subscribe to circuit breaker events
    cb.onStateChange((state) => {
      const stateStr = this.circuitStateToString(state);
      this.logger.log(`Circuit breaker state changed for ${serviceName}: ${stateStr}`);

      this.eventEmitter.emit('circuit-breaker.state-change', {
        serviceName,
        state: stateStr,
      });

      // Persist state change
      this.persistState(serviceName, stateStr).catch((err) => {
        this.logger.error(`Failed to persist circuit state: ${err.message}`);
      });
    });

    // Create retry policy with exponential backoff
    const retryPolicy = retry(handleAll, {
      maxAttempts: config.maxRetries,
      backoff: new ExponentialBackoff({
        initialDelay: config.initialDelayMs,
        maxDelay: config.maxDelayMs,
      }),
    });

    // Create timeout policy (Aggressive = cancel immediately on timeout)
    const timeoutPolicy = timeout(config.timeoutMs, TimeoutStrategy.Aggressive);

    // Create bulkhead for concurrency limiting
    const bulkheadPolicy = bulkhead(config.maxConcurrent, config.maxQueue);

    // Combine policies: timeout -> bulkhead -> circuit breaker -> retry
    // Order matters: timeout is outermost, retry is innermost
    const combined = wrap(timeoutPolicy, bulkheadPolicy, cb, retryPolicy);

    return {
      config,
      circuitBreaker: cb,
      retry: retryPolicy,
      timeout: timeoutPolicy,
      bulkhead: bulkheadPolicy,
      combined,
      stats: {
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        totalTimeouts: 0,
      },
    };
  }

  /**
   * Get configuration for a service
   */
  private getServiceConfig(serviceName: string): ServiceConfig {
    // Try to find a matching config prefix
    let baseConfig = DEFAULT_CONFIGS['default'];
    for (const [prefix, config] of Object.entries(DEFAULT_CONFIGS)) {
      if (serviceName.startsWith(prefix)) {
        baseConfig = config;
        break;
      }
    }

    // Allow overrides from environment
    const envPrefix = `CIRCUIT_BREAKER_${serviceName.toUpperCase().replace(/-/g, '_')}`;

    return {
      name: serviceName,
      failureThreshold: this.configService.get<number>(
        `${envPrefix}_FAILURE_THRESHOLD`,
        baseConfig.failureThreshold!,
      ),
      successThreshold: this.configService.get<number>(
        `${envPrefix}_SUCCESS_THRESHOLD`,
        baseConfig.successThreshold!,
      ),
      resetTimeoutMs: this.configService.get<number>(
        `${envPrefix}_RESET_TIMEOUT_MS`,
        baseConfig.resetTimeoutMs!,
      ),
      maxRetries: this.configService.get<number>(
        `${envPrefix}_MAX_RETRIES`,
        baseConfig.maxRetries!,
      ),
      initialDelayMs: this.configService.get<number>(
        `${envPrefix}_INITIAL_DELAY_MS`,
        baseConfig.initialDelayMs!,
      ),
      maxDelayMs: this.configService.get<number>(
        `${envPrefix}_MAX_DELAY_MS`,
        baseConfig.maxDelayMs!,
      ),
      timeoutMs: this.configService.get<number>(
        `${envPrefix}_TIMEOUT_MS`,
        baseConfig.timeoutMs!,
      ),
      maxConcurrent: this.configService.get<number>(
        `${envPrefix}_MAX_CONCURRENT`,
        baseConfig.maxConcurrent!,
      ),
      maxQueue: this.configService.get<number>(
        `${envPrefix}_MAX_QUEUE`,
        baseConfig.maxQueue!,
      ),
    };
  }

  /**
   * Convert Cockatiel circuit state to string
   */
  private circuitStateToString(state: CircuitState): CircuitBreakerStateEnum {
    switch (state) {
      case CircuitState.Open:
        return CircuitBreakerStateEnum.OPEN;
      case CircuitState.HalfOpen:
        return CircuitBreakerStateEnum.HALF_OPEN;
      default:
        return CircuitBreakerStateEnum.CLOSED;
    }
  }

  /**
   * Load persisted circuit breaker states from database
   */
  private async loadPersistedStates(): Promise<void> {
    try {
      const states = await this.prisma.circuitBreakerState.findMany();

      for (const state of states) {
        // Initialize policy with persisted stats
        const policy = this.getPolicy(state.serviceName);
        policy.stats.totalRequests = state.totalRequests;
        policy.stats.totalFailures = state.totalFailures;
        policy.stats.totalSuccesses = state.totalSuccesses;
        policy.stats.totalTimeouts = state.totalTimeouts;

        this.logger.debug(
          `Loaded circuit breaker state for ${state.serviceName}: ${state.state}`,
        );
      }
    } catch (error) {
      this.logger.warn(`Failed to load persisted circuit states: ${error.message}`);
    }
  }

  /**
   * Persist circuit breaker state to database
   */
  private async persistState(
    serviceName: string,
    state: CircuitBreakerStateEnum,
  ): Promise<void> {
    const policy = this.policies.get(serviceName);
    if (!policy) return;

    const now = new Date();

    await this.prisma.circuitBreakerState.upsert({
      where: { serviceName },
      create: {
        serviceName,
        state,
        failureCount: policy.stats.totalFailures,
        successCount: policy.stats.totalSuccesses,
        failureThreshold: policy.config.failureThreshold,
        successThreshold: policy.config.successThreshold,
        resetTimeoutMs: policy.config.resetTimeoutMs,
        totalRequests: policy.stats.totalRequests,
        totalFailures: policy.stats.totalFailures,
        totalSuccesses: policy.stats.totalSuccesses,
        totalTimeouts: policy.stats.totalTimeouts,
        lastFailureAt: state === CircuitBreakerStateEnum.OPEN ? now : null,
        openedAt: state === CircuitBreakerStateEnum.OPEN ? now : null,
        halfOpenAt: state === CircuitBreakerStateEnum.HALF_OPEN ? now : null,
      },
      update: {
        state,
        failureCount: policy.stats.totalFailures,
        successCount: policy.stats.totalSuccesses,
        totalRequests: policy.stats.totalRequests,
        totalFailures: policy.stats.totalFailures,
        totalSuccesses: policy.stats.totalSuccesses,
        totalTimeouts: policy.stats.totalTimeouts,
        lastFailureAt:
          state === CircuitBreakerStateEnum.OPEN ? now : undefined,
        lastSuccessAt:
          state === CircuitBreakerStateEnum.CLOSED ? now : undefined,
        openedAt:
          state === CircuitBreakerStateEnum.OPEN ? now : undefined,
        halfOpenAt:
          state === CircuitBreakerStateEnum.HALF_OPEN ? now : undefined,
      },
    });
  }

  /**
   * Persist all circuit breaker states
   */
  private async persistAllStates(): Promise<void> {
    for (const [serviceName] of this.policies) {
      await this.persistState(serviceName, this.getCircuitState(serviceName));
    }
  }

  /**
   * Log a recovery action
   */
  private async logRecoveryAction(
    targetId: string,
    actionType: string,
    previousState: string,
    newState: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.recoveryLog.create({
        data: {
          actionType,
          targetType: 'CIRCUIT_BREAKER',
          targetId,
          previousState,
          newState,
          reason,
          actorType: 'SYSTEM',
          success: true,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to log recovery action: ${error.message}`);
    }
  }

  // =========================================================================
  // v2.0.0: Agent Routing with Health-Aware Selection
  // =========================================================================

  /**
   * Agent health tracking for routing decisions
   */
  private agentHealth: Map<string, AgentHealthScore> = new Map();

  /**
   * Select the healthiest available agent from a list
   * Uses circuit breaker state + recent success rate for scoring
   */
  selectHealthyAgent(agents: string[]): AgentSelectionResult {
    if (agents.length === 0) {
      return { selected: null, reason: 'No agents available' };
    }

    // Calculate health scores for all agents
    const scored = agents.map(agentId => ({
      agentId,
      score: this.calculateAgentHealthScore(agentId),
      state: this.getCircuitState(agentId),
    }));

    // Filter out open circuit breakers (completely unavailable)
    const available = scored.filter(a => a.state !== CircuitBreakerStateEnum.OPEN);

    if (available.length === 0) {
      // All agents have open circuits - use least recently failed
      const leastRecentlyFailed = scored.sort((a, b) =>
        (this.agentHealth.get(a.agentId)?.lastFailureAt?.getTime() || 0) -
        (this.agentHealth.get(b.agentId)?.lastFailureAt?.getTime() || 0)
      )[0];

      return {
        selected: leastRecentlyFailed?.agentId || null,
        reason: 'All agents have open circuits, selecting least recently failed',
        allUnavailable: true,
      };
    }

    // Sort by health score (higher is better)
    available.sort((a, b) => b.score - a.score);

    const selected = available[0];

    // Log selection decision for debugging
    this.logger.debug(
      `Agent selection: ${selected.agentId} (score: ${selected.score.toFixed(2)}, state: ${selected.state})`,
    );

    return {
      selected: selected.agentId,
      score: selected.score,
      reason: `Selected healthiest agent with score ${selected.score.toFixed(2)}`,
      alternatives: available.slice(1).map(a => a.agentId),
    };
  }

  /**
   * Execute with automatic agent failover
   * Tries agents in order of health until one succeeds
   */
  async executeWithAgentFailover<T>(
    agents: string[],
    fn: (agentId: string) => Promise<T>,
    maxAttempts: number = 3,
  ): Promise<AgentExecutionResult<T>> {
    const attemptedAgents: string[] = [];
    let lastError: Error | null = null;

    // Sort agents by health
    const sortedAgents = [...agents].sort((a, b) =>
      this.calculateAgentHealthScore(b) - this.calculateAgentHealthScore(a)
    );

    for (let attempt = 0; attempt < Math.min(maxAttempts, sortedAgents.length); attempt++) {
      const agentId = sortedAgents[attempt];
      attemptedAgents.push(agentId);

      try {
        // Execute with circuit breaker protection
        const result = await this.execute(agentId, () => fn(agentId));

        // Record success
        this.recordAgentSuccess(agentId);

        return {
          success: true,
          result,
          usedAgent: agentId,
          attemptedAgents,
          failoverCount: attempt,
        };
      } catch (error) {
        lastError = error as Error;

        // Record failure
        this.recordAgentFailure(agentId, lastError.message);

        this.logger.warn(
          `Agent ${agentId} failed (attempt ${attempt + 1}/${maxAttempts}): ${lastError.message}`,
        );

        // Emit failover event
        this.eventEmitter.emit('agent.failover', {
          fromAgent: agentId,
          toAgent: sortedAgents[attempt + 1] || null,
          error: lastError.message,
          attempt: attempt + 1,
        });
      }
    }

    return {
      success: false,
      error: lastError?.message || 'All agents failed',
      usedAgent: null,
      attemptedAgents,
      failoverCount: attemptedAgents.length - 1,
    };
  }

  /**
   * Record a successful agent interaction
   */
  recordAgentSuccess(agentId: string): void {
    const current = this.agentHealth.get(agentId) || this.createDefaultHealthScore(agentId);

    current.successCount++;
    current.consecutiveFailures = 0;
    current.lastSuccessAt = new Date();
    current.responseTimeMs.push(Date.now()); // Would track actual response time in production

    // Keep only last 100 response times
    if (current.responseTimeMs.length > 100) {
      current.responseTimeMs.shift();
    }

    this.agentHealth.set(agentId, current);
  }

  /**
   * Record a failed agent interaction
   */
  recordAgentFailure(agentId: string, error: string): void {
    const current = this.agentHealth.get(agentId) || this.createDefaultHealthScore(agentId);

    current.failureCount++;
    current.consecutiveFailures++;
    current.lastFailureAt = new Date();
    current.lastError = error;

    this.agentHealth.set(agentId, current);
  }

  /**
   * Get health score for a specific agent
   */
  getAgentHealth(agentId: string): AgentHealthScore | null {
    return this.agentHealth.get(agentId) || null;
  }

  /**
   * Get health overview for all tracked agents
   */
  getAllAgentHealth(): AgentHealthOverview {
    const agents: AgentHealthScore[] = [];
    let healthyCount = 0;
    let unhealthyCount = 0;
    let degradedCount = 0;

    for (const [agentId, health] of this.agentHealth) {
      agents.push({ ...health, agentId });

      const circuitState = this.getCircuitState(agentId);
      if (circuitState === CircuitBreakerStateEnum.OPEN) {
        unhealthyCount++;
      } else if (circuitState === CircuitBreakerStateEnum.HALF_OPEN || health.consecutiveFailures > 0) {
        degradedCount++;
      } else {
        healthyCount++;
      }
    }

    return {
      agents,
      summary: {
        total: agents.length,
        healthy: healthyCount,
        degraded: degradedCount,
        unhealthy: unhealthyCount,
      },
    };
  }

  /**
   * Calculate health score for an agent (0-100)
   */
  private calculateAgentHealthScore(agentId: string): number {
    const health = this.agentHealth.get(agentId);
    const circuitState = this.getCircuitState(agentId);

    // Base score
    let score = 100;

    // Penalize based on circuit state
    if (circuitState === CircuitBreakerStateEnum.OPEN) {
      score -= 80; // Heavily penalize open circuit
    } else if (circuitState === CircuitBreakerStateEnum.HALF_OPEN) {
      score -= 30; // Moderate penalty for half-open
    }

    if (!health) {
      return score; // No history, use base score
    }

    // Penalize based on consecutive failures
    score -= Math.min(health.consecutiveFailures * 10, 40);

    // Factor in success rate
    const total = health.successCount + health.failureCount;
    if (total > 0) {
      const successRate = health.successCount / total;
      score *= successRate;
    }

    // Recency bonus - agents that succeeded recently get a boost
    if (health.lastSuccessAt) {
      const timeSinceSuccess = Date.now() - health.lastSuccessAt.getTime();
      if (timeSinceSuccess < 60000) { // Success within last minute
        score += 10;
      } else if (timeSinceSuccess < 300000) { // Success within last 5 minutes
        score += 5;
      }
    }

    // Recency penalty - recent failures reduce score
    if (health.lastFailureAt) {
      const timeSinceFailure = Date.now() - health.lastFailureAt.getTime();
      if (timeSinceFailure < 30000) { // Failure within last 30 seconds
        score -= 20;
      } else if (timeSinceFailure < 60000) { // Failure within last minute
        score -= 10;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Create default health score for new agent
   */
  private createDefaultHealthScore(agentId: string): AgentHealthScore {
    return {
      agentId,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      responseTimeMs: [],
    };
  }
}

// =========================================================================
// v2.0.0: Agent Routing Types
// =========================================================================

export interface AgentHealthScore {
  agentId: string;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  responseTimeMs: number[];
}

export interface AgentSelectionResult {
  selected: string | null;
  score?: number;
  reason: string;
  alternatives?: string[];
  allUnavailable?: boolean;
}

export interface AgentExecutionResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  usedAgent: string | null;
  attemptedAgents: string[];
  failoverCount: number;
}

export interface AgentHealthOverview {
  agents: AgentHealthScore[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}
