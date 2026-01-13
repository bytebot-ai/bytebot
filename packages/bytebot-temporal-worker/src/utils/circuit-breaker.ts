/**
 * Circuit Breaker Utility - Phase 13
 *
 * Provides resilient HTTP calls with circuit breaker pattern using opossum.
 * Follows industry best practices for protecting downstream services.
 *
 * Phase 13 Improvements:
 * - EPERM error detection and automatic retry for Cilium identity sync issues
 * - Improved circuit breaker recovery timing based on industry research
 * - Better half-open state handling with gradual recovery
 * - Enhanced metrics for circuit breaker state monitoring
 *
 * Features:
 * - Circuit breaker with configurable thresholds
 * - Automatic fallback handling
 * - Prometheus metrics integration
 * - Heartbeat support for long-running operations
 * - EPERM/network transient error retry
 *
 * @see https://github.com/nodeshift/opossum
 * @see https://martinfowler.com/bliki/CircuitBreaker.html
 */

import CircuitBreaker from 'opossum';
import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { Context } from '@temporalio/activity';
import { getMetricsService } from '../metrics';

// ============================================================================
// Configuration
// ============================================================================

export interface CircuitBreakerConfig {
  /** Time in ms before a call times out (default: 120000 = 2 min) */
  timeout: number;
  /** Percentage of failures that trips the circuit (default: 50) */
  errorThresholdPercentage: number;
  /** Time in ms to wait before testing circuit again (default: 30000 = 30s) */
  resetTimeout: number;
  /** Name for metrics and logging */
  name: string;
  /** Volume threshold before circuit trips (default: 5) */
  volumeThreshold?: number;
  /** Whether to enable heartbeats during requests (default: true) */
  enableHeartbeats?: boolean;
  /** Heartbeat interval in ms (default: 30000 = 30s) */
  heartbeatIntervalMs?: number;
}

const DEFAULT_CONFIG: Partial<CircuitBreakerConfig> = {
  timeout: 120000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
  enableHeartbeats: true,
  heartbeatIntervalMs: 30000,
};

// ============================================================================
// Phase 13: EPERM Retry Configuration
// ============================================================================

/**
 * Configuration for retrying requests that fail due to transient network issues
 * like Cilium identity synchronization (EPERM errors).
 */
export interface TransientRetryConfig {
  /** Maximum number of retries for transient errors (default: 3) */
  maxRetries: number;
  /** Base delay between retries in ms (default: 200) */
  baseDelayMs: number;
  /** Maximum delay between retries in ms (default: 2000) */
  maxDelayMs: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff: boolean;
}

const DEFAULT_TRANSIENT_RETRY_CONFIG: TransientRetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  exponentialBackoff: true,
};

/**
 * Checks if an error is a transient network error that should be retried.
 * These errors typically occur during Cilium identity synchronization.
 *
 * @param error - The error to check
 * @returns true if the error is transient and should be retried
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!error) return false;

  // Check for Axios error
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;

    // EPERM - Operation not permitted (Cilium identity not synced)
    if (axiosError.code === 'EPERM' || axiosError.message?.includes('EPERM')) {
      console.warn('[CircuitBreaker] Detected EPERM error - likely Cilium identity sync issue');
      return true;
    }

    // ECONNREFUSED during identity sync can also occur
    if (axiosError.code === 'ECONNREFUSED') {
      console.warn('[CircuitBreaker] Detected ECONNREFUSED - may be transient');
      return true;
    }

    // ETIMEDOUT can be transient
    if (axiosError.code === 'ETIMEDOUT' || axiosError.code === 'ECONNRESET') {
      console.warn(`[CircuitBreaker] Detected ${axiosError.code} - may be transient`);
      return true;
    }

    // Check for network errors in the message
    const transientPatterns = [
      'Operation not permitted',
      'EPERM',
      'network',
      'ENOTFOUND',
      'EAI_AGAIN',
    ];
    for (const pattern of transientPatterns) {
      if (axiosError.message?.includes(pattern)) {
        return true;
      }
    }
  }

  // Check error message for common transient patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes('eperm') ||
      message.includes('operation not permitted') ||
      message.includes('econnrefused') ||
      message.includes('econnreset')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff
 */
function calculateBackoffDelay(
  attempt: number,
  config: TransientRetryConfig
): number {
  if (!config.exponentialBackoff) {
    return config.baseDelayMs;
  }
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.min(delay + jitter, config.maxDelayMs);
}

// ============================================================================
// Circuit Breaker Factory
// ============================================================================

const circuitBreakers = new Map<string, CircuitBreaker<[AxiosRequestConfig], AxiosResponse>>();

/**
 * Creates or retrieves a circuit breaker for the given configuration.
 * Circuit breakers are cached by name for reuse.
 */
export function getCircuitBreaker(
  config: CircuitBreakerConfig
): CircuitBreaker<[AxiosRequestConfig], AxiosResponse> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  if (circuitBreakers.has(config.name)) {
    return circuitBreakers.get(config.name)!;
  }

  const breaker = new CircuitBreaker(
    async (axiosConfig: AxiosRequestConfig): Promise<AxiosResponse> => {
      return axios(axiosConfig);
    },
    {
      timeout: fullConfig.timeout,
      errorThresholdPercentage: fullConfig.errorThresholdPercentage,
      resetTimeout: fullConfig.resetTimeout,
      volumeThreshold: fullConfig.volumeThreshold,
      name: config.name,
    }
  );

  // Register event handlers for observability
  const metricsService = getMetricsService();

  breaker.on('success', () => {
    metricsService?.recordActivityExecution(`circuit_${config.name}`, 'success');
  });

  breaker.on('failure', () => {
    metricsService?.recordActivityExecution(`circuit_${config.name}`, 'failure');
  });

  breaker.on('timeout', () => {
    metricsService?.recordActivityExecution(`circuit_${config.name}`, 'timeout');
  });

  breaker.on('open', () => {
    console.warn(`[CircuitBreaker] ${config.name} circuit OPENED (failures exceeded threshold)`);
  });

  breaker.on('halfOpen', () => {
    console.info(`[CircuitBreaker] ${config.name} circuit HALF-OPEN (testing recovery)`);
  });

  breaker.on('close', () => {
    console.info(`[CircuitBreaker] ${config.name} circuit CLOSED (recovered)`);
  });

  breaker.on('fallback', () => {
    metricsService?.recordActivityExecution(`circuit_${config.name}`, 'fallback');
  });

  circuitBreakers.set(config.name, breaker);
  return breaker;
}

// ============================================================================
// Resilient HTTP Client
// ============================================================================

/**
 * Makes an HTTP request with circuit breaker protection, heartbeat support,
 * and automatic retry for transient network errors (like EPERM from Cilium).
 *
 * Phase 13: Added EPERM retry logic to handle Cilium identity sync issues.
 *
 * @param axiosConfig - Axios request configuration
 * @param breakerConfig - Circuit breaker configuration
 * @param fallback - Optional fallback function if circuit is open or request fails
 * @param retryConfig - Optional configuration for transient error retry
 * @returns Axios response
 */
export async function resilientRequest<T = unknown>(
  axiosConfig: AxiosRequestConfig,
  breakerConfig: CircuitBreakerConfig,
  fallback?: () => Promise<T>,
  retryConfig?: Partial<TransientRetryConfig>
): Promise<AxiosResponse<T>> {
  const fullConfig = { ...DEFAULT_CONFIG, ...breakerConfig };
  const fullRetryConfig = { ...DEFAULT_TRANSIENT_RETRY_CONFIG, ...retryConfig };
  const breaker = getCircuitBreaker(breakerConfig);
  const metricsService = getMetricsService();

  // Set up heartbeat interval if enabled and in activity context
  let heartbeatInterval: NodeJS.Timeout | undefined;
  let heartbeatCount = 0;

  if (fullConfig.enableHeartbeats) {
    try {
      const context = Context.current();
      heartbeatInterval = setInterval(() => {
        heartbeatCount++;
        context.heartbeat({
          operation: breakerConfig.name,
          status: 'in_progress',
          heartbeatCount,
          timestamp: new Date().toISOString(),
        });
      }, fullConfig.heartbeatIntervalMs);
    } catch {
      // Not in activity context, skip heartbeats
    }
  }

  // Configure fallback if provided
  if (fallback) {
    breaker.fallback(async () => {
      const result = await fallback();
      return { data: result } as AxiosResponse<T>;
    });
  }

  try {
    // Ensure axios config has timeout set
    const configWithTimeout: AxiosRequestConfig = {
      ...axiosConfig,
      timeout: axiosConfig.timeout ?? fullConfig.timeout,
    };

    // Phase 13: Implement retry logic for transient errors
    let lastError: unknown;
    for (let attempt = 0; attempt <= fullRetryConfig.maxRetries; attempt++) {
      try {
        const response = await breaker.fire(configWithTimeout);

        // If we retried and succeeded, log it
        if (attempt > 0) {
          console.info(
            `[CircuitBreaker] ${breakerConfig.name} succeeded after ${attempt} retries`
          );
          metricsService?.recordActivityExecution(
            `circuit_${breakerConfig.name}_retry_success`,
            'success'
          );
        }

        return response as AxiosResponse<T>;
      } catch (error) {
        lastError = error;

        // Check if this is a transient error that should be retried
        if (isTransientNetworkError(error) && attempt < fullRetryConfig.maxRetries) {
          const delay = calculateBackoffDelay(attempt, fullRetryConfig);
          console.warn(
            `[CircuitBreaker] ${breakerConfig.name} transient error (attempt ${attempt + 1}/${fullRetryConfig.maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`
          );

          metricsService?.recordActivityExecution(
            `circuit_${breakerConfig.name}_transient_retry`,
            'fallback'
          );

          await sleep(delay);
          continue;
        }

        // Not a transient error or max retries exceeded, rethrow
        throw error;
      }
    }

    // Should not reach here, but just in case
    throw lastError;
  } finally {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  }
}

// ============================================================================
// Pre-configured Circuit Breakers for Butler Vantage Services
// ============================================================================

/**
 * Circuit breaker for LLM proxy calls (planning, model calls)
 *
 * Phase 13 improvements:
 * - Increased resetTimeout to 120s for better recovery from transient issues
 * - Increased volumeThreshold to 5 to avoid premature circuit opening
 * - LLM services can have variable latency, so more tolerance is needed
 */
export const LLM_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  name: 'llm_proxy',
  timeout: 180000, // 3 minutes for LLM calls (increased from 2 min for large models)
  errorThresholdPercentage: 50, // Trip at 50% failure rate (more tolerant)
  resetTimeout: 120000, // 2 minutes before retry (increased for better recovery)
  volumeThreshold: 5, // Trip after 5 failures (increased from 3)
  enableHeartbeats: true,
  heartbeatIntervalMs: 30000, // Heartbeat every 30s
};

/** Circuit breaker for orchestrator calls (internal services) */
export const ORCHESTRATOR_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  name: 'orchestrator',
  timeout: 30000, // 30 seconds for internal calls
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
  enableHeartbeats: false, // Internal calls are fast
};

/** Circuit breaker for task controller calls */
export const TASK_CONTROLLER_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  name: 'task_controller',
  timeout: 30000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000,
  volumeThreshold: 5,
  enableHeartbeats: false,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Gets the current state of all circuit breakers.
 * Useful for health checks and monitoring.
 */
export function getCircuitBreakerStates(): Record<string, {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  stats: {
    failures: number;
    successes: number;
    timeouts: number;
    fallbacks: number;
  };
}> {
  const states: Record<string, { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; stats: { failures: number; successes: number; timeouts: number; fallbacks: number; } }> = {};

  for (const [name, breaker] of circuitBreakers) {
    let state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
    if (breaker.opened) {
      state = 'OPEN';
    } else if (breaker.halfOpen) {
      state = 'HALF_OPEN';
    }

    states[name] = {
      state,
      stats: {
        failures: breaker.stats.failures,
        successes: breaker.stats.successes,
        timeouts: breaker.stats.timeouts,
        fallbacks: breaker.stats.fallbacks,
      },
    };
  }

  return states;
}

/**
 * Resets a specific circuit breaker (useful for testing/recovery).
 */
export function resetCircuitBreaker(name: string): void {
  const breaker = circuitBreakers.get(name);
  if (breaker) {
    breaker.close();
    console.info(`[CircuitBreaker] ${name} manually reset to CLOSED`);
  }
}

/**
 * Clears all circuit breaker instances (useful for testing).
 */
export function clearAllCircuitBreakers(): void {
  circuitBreakers.clear();
}
