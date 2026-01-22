/**
 * LLM Resilience Service
 * v1.0.0: Industry-standard retry logic for LLM API calls
 *
 * Implements patterns from:
 * - OpenAI: Exponential backoff with jitter
 * - Anthropic: Retry-after header respect
 * - Manus: "Diagnose → Retry → Pivot" error handling
 * - Google SRE: Circuit breaker pattern
 *
 * This service provides:
 * - Exponential backoff with jitter (prevents thundering herd)
 * - Configurable retry attempts (default: 5 for transient failures)
 * - Error classification (transient vs. permanent)
 * - Retry-after header support (HTTP 429, 503)
 * - Circuit breaker for cascading failure prevention
 * - Observability metrics for monitoring
 *
 * @see https://platform.openai.com/docs/guides/rate-limits
 * @see https://docs.anthropic.com/en/api/errors
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// =============================================================================
// Error Classification Types
// =============================================================================

export enum LLMErrorType {
  // Transient errors - retry with backoff
  RATE_LIMIT = 'RATE_LIMIT',           // 429: Rate limit exceeded
  SERVER_ERROR = 'SERVER_ERROR',       // 5xx: Server-side error
  TIMEOUT = 'TIMEOUT',                 // Request timeout
  NETWORK = 'NETWORK',                 // Connection errors
  OVERLOADED = 'OVERLOADED',           // 529: Overloaded (Anthropic)

  // Permanent errors - do not retry
  AUTH_ERROR = 'AUTH_ERROR',           // 401/403: Authentication/authorization
  BAD_REQUEST = 'BAD_REQUEST',         // 400: Invalid request
  NOT_FOUND = 'NOT_FOUND',             // 404: Model/resource not found
  CONTENT_FILTER = 'CONTENT_FILTER',   // Content moderation triggered
  CONTEXT_LENGTH = 'CONTEXT_LENGTH',   // Context length exceeded

  // Unknown
  UNKNOWN = 'UNKNOWN',
}

export interface LLMError {
  type: LLMErrorType;
  message: string;
  statusCode?: number;
  retryable: boolean;
  retryAfterMs?: number;
  originalError?: Error;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number; // 0-1, percentage of delay to add as jitter
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: LLMError;
  attempts: number;
  totalDurationMs: number;
}

// =============================================================================
// Circuit Breaker State
// =============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure?: Date;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  openedAt?: Date;
}

// =============================================================================
// Service Implementation
// =============================================================================

@Injectable()
export class LLMResilienceService {
  private readonly logger = new Logger(LLMResilienceService.name);

  // Circuit breaker per endpoint/provider
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();

  // Default configuration
  private readonly defaultConfig: RetryConfig;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerResetMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.defaultConfig = {
      maxRetries: parseInt(this.configService.get('LLM_MAX_RETRIES', '5'), 10),
      baseDelayMs: parseInt(this.configService.get('LLM_BASE_DELAY_MS', '1000'), 10),
      maxDelayMs: parseInt(this.configService.get('LLM_MAX_DELAY_MS', '60000'), 10),
      jitterFactor: parseFloat(this.configService.get('LLM_JITTER_FACTOR', '0.3')),
    };

    this.circuitBreakerThreshold = parseInt(
      this.configService.get('LLM_CIRCUIT_BREAKER_THRESHOLD', '5'),
      10,
    );
    this.circuitBreakerResetMs = parseInt(
      // Default to 2 minutes to reduce hammering during upstream outages.
      this.configService.get('LLM_CIRCUIT_BREAKER_RESET_MS', '120000'),
      10,
    );

    this.logger.log(
      `LLMResilienceService initialized (maxRetries: ${this.defaultConfig.maxRetries}, ` +
      `baseDelay: ${this.defaultConfig.baseDelayMs}ms, ` +
      `circuitBreaker: ${this.circuitBreakerThreshold} failures)`,
    );
  }

  /**
   * Execute an LLM API call with retry logic
   *
   * @param operation - Async function that makes the LLM API call
   * @param endpoint - Identifier for circuit breaker tracking (e.g., 'litellm', 'openai')
   * @param config - Optional retry configuration override
   * @returns Result with success status, result/error, and metrics
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    endpoint: string = 'default',
    config?: Partial<RetryConfig>,
  ): Promise<RetryResult<T>> {
    const retryConfig = { ...this.defaultConfig, ...config };
    const startTime = Date.now();
    let attempts = 0;
    let lastError: LLMError | undefined;

    // Check circuit breaker before attempting
    if (this.isCircuitOpen(endpoint)) {
      this.logger.warn(`Circuit breaker OPEN for ${endpoint}, failing fast`);
      return {
        success: false,
        error: {
          type: LLMErrorType.SERVER_ERROR,
          message: `Circuit breaker open for ${endpoint}`,
          retryable: false,
        },
        attempts: 0,
        totalDurationMs: Date.now() - startTime,
      };
    }

    while (attempts <= retryConfig.maxRetries) {
      attempts++;

      try {
        this.logger.debug(
          `LLM call attempt ${attempts}/${retryConfig.maxRetries + 1} to ${endpoint}`,
        );

        const result = await operation();

        // Success - reset circuit breaker
        this.recordSuccess(endpoint);

        // Emit success metric
        this.eventEmitter.emit('llm.call.success', {
          endpoint,
          attempts,
          durationMs: Date.now() - startTime,
        });

        return {
          success: true,
          result,
          attempts,
          totalDurationMs: Date.now() - startTime,
        };
      } catch (error: any) {
        lastError = this.classifyError(error);

        this.logger.warn(
          `LLM call attempt ${attempts} failed: ${lastError.type} - ${lastError.message}`,
        );

        // Record failure for circuit breaker (only for retryable/transient failures)
        if (lastError.retryable) {
          this.recordFailure(endpoint, lastError);
        }

        // If error is not retryable, fail immediately
        if (!lastError.retryable) {
          this.logger.error(
            `LLM call failed with non-retryable error: ${lastError.type}`,
          );
          break;
        }

        // If we've exhausted retries, fail
        if (attempts > retryConfig.maxRetries) {
          this.logger.error(
            `LLM call failed after ${attempts} attempts, exhausted retries`,
          );
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = this.calculateDelay(
          attempts,
          retryConfig,
          lastError.retryAfterMs,
        );

        this.logger.log(
          `Retrying LLM call in ${Math.round(delay)}ms ` +
          `(attempt ${attempts + 1}/${retryConfig.maxRetries + 1})`,
        );

        await this.sleep(delay);
      }
    }

    // Emit failure metric
    this.eventEmitter.emit('llm.call.failed', {
      endpoint,
      attempts,
      durationMs: Date.now() - startTime,
      errorType: lastError?.type,
    });

    return {
      success: false,
      error: lastError,
      attempts,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Classify an error to determine if it's retryable
   */
  classifyError(error: any): LLMError {
    const message = error?.message || String(error);
    const statusCode = error?.status || error?.statusCode || error?.code;

    // Rate limit (429)
    if (statusCode === 429 || message.toLowerCase().includes('rate limit')) {
      const retryAfterMs = this.parseRetryAfter(error);
      return {
        type: LLMErrorType.RATE_LIMIT,
        message: message,
        statusCode: 429,
        retryable: true,
        retryAfterMs,
        originalError: error,
      };
    }

    // Overloaded (529 - Anthropic specific)
    if (statusCode === 529 || message.toLowerCase().includes('overloaded')) {
      return {
        type: LLMErrorType.OVERLOADED,
        message: message,
        statusCode: 529,
        retryable: true,
        retryAfterMs: 5000, // Default 5s for overload
        originalError: error,
      };
    }

    // Server errors (5xx)
    if (statusCode >= 500 && statusCode < 600) {
      return {
        type: LLMErrorType.SERVER_ERROR,
        message: message,
        statusCode,
        retryable: true,
        originalError: error,
      };
    }

    // Timeout
    if (
      message.toLowerCase().includes('timeout') ||
      message.toLowerCase().includes('etimedout') ||
      error?.code === 'ETIMEDOUT' ||
      error?.code === 'ESOCKETTIMEDOUT'
    ) {
      return {
        type: LLMErrorType.TIMEOUT,
        message: message,
        retryable: true,
        originalError: error,
      };
    }

    // Network errors
    if (
      message.toLowerCase().includes('econnrefused') ||
      message.toLowerCase().includes('enotfound') ||
      message.toLowerCase().includes('socket hang up') ||
      message.toLowerCase().includes('network') ||
      message.toLowerCase().includes('connection') ||
      error?.code === 'ECONNREFUSED' ||
      error?.code === 'ENOTFOUND' ||
      error?.code === 'ECONNRESET'
    ) {
      return {
        type: LLMErrorType.NETWORK,
        message: message,
        retryable: true,
        originalError: error,
      };
    }

    // Authentication errors (401, 403)
    if (statusCode === 401 || statusCode === 403) {
      return {
        type: LLMErrorType.AUTH_ERROR,
        message: message,
        statusCode,
        retryable: false,
        originalError: error,
      };
    }

    // Bad request (400)
    if (statusCode === 400) {
      return {
        type: LLMErrorType.BAD_REQUEST,
        message: message,
        statusCode: 400,
        retryable: false,
        originalError: error,
      };
    }

    // Not found (404)
    if (statusCode === 404) {
      return {
        type: LLMErrorType.NOT_FOUND,
        message: message,
        statusCode: 404,
        retryable: false,
        originalError: error,
      };
    }

    // Content filter / moderation
    if (
      message.toLowerCase().includes('content') &&
      (message.toLowerCase().includes('filter') ||
        message.toLowerCase().includes('moderation') ||
        message.toLowerCase().includes('policy'))
    ) {
      return {
        type: LLMErrorType.CONTENT_FILTER,
        message: message,
        retryable: false,
        originalError: error,
      };
    }

    // Context length exceeded
    if (
      message.toLowerCase().includes('context') ||
      message.toLowerCase().includes('token') ||
      message.toLowerCase().includes('length')
    ) {
      return {
        type: LLMErrorType.CONTEXT_LENGTH,
        message: message,
        retryable: false,
        originalError: error,
      };
    }

    // Unknown - default to retryable for safety
    return {
      type: LLMErrorType.UNKNOWN,
      message: message,
      retryable: true, // Conservative: retry unknown errors
      originalError: error,
    };
  }

  /**
   * Calculate delay with exponential backoff and jitter
   *
   * Formula: min(maxDelay, baseDelay * 2^attempt) + random_jitter
   */
  private calculateDelay(
    attempt: number,
    config: RetryConfig,
    retryAfterMs?: number,
  ): number {
    // If server specified retry-after, use it (with bounds)
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, config.maxDelayMs);
    }

    // Exponential backoff: baseDelay * 2^(attempt-1)
    const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt - 1);
    const boundedDelay = Math.min(exponentialDelay, config.maxDelayMs);

    // Add jitter: random value between 0 and jitterFactor * delay
    const jitter = Math.random() * config.jitterFactor * boundedDelay;

    return boundedDelay + jitter;
  }

  /**
   * Parse retry-after header from error response
   */
  private parseRetryAfter(error: any): number | undefined {
    // Check for retry-after in headers
    const retryAfter =
      error?.headers?.['retry-after'] ||
      error?.response?.headers?.['retry-after'] ||
      error?.error?.headers?.['retry-after'];

    if (!retryAfter) return undefined;

    // Could be seconds (number) or HTTP date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000; // Convert to ms
    }

    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }

    return undefined;
  }

  /**
   * Check if circuit breaker is open for an endpoint
   */
  private isCircuitOpen(endpoint: string): boolean {
    const state = this.circuitBreakers.get(endpoint);
    if (!state || state.state === 'CLOSED') return false;

    if (state.state === 'OPEN') {
      // Check if it's time to try half-open
      const timeSinceOpen = Date.now() - (state.openedAt?.getTime() || 0);
      if (timeSinceOpen >= this.circuitBreakerResetMs) {
        state.state = 'HALF_OPEN';
        this.logger.log(`Circuit breaker for ${endpoint} moving to HALF_OPEN`);
        this.eventEmitter.emit('llm.circuit.state-changed', {
          endpoint,
          state: 'HALF_OPEN',
        });
        return false; // Allow one request through
      }
      return true;
    }

    return false; // HALF_OPEN allows requests
  }

  /**
   * Record a successful call (resets circuit breaker)
   */
  private recordSuccess(endpoint: string): void {
    const state = this.circuitBreakers.get(endpoint);
    if (state) {
      const previousState = state.state;
      if (state.state === 'HALF_OPEN') {
        this.logger.log(`Circuit breaker for ${endpoint} reset to CLOSED`);
      }
      state.failures = 0;
      state.state = 'CLOSED';
      state.openedAt = undefined;

      if (previousState !== 'CLOSED') {
        this.eventEmitter.emit('llm.circuit.state-changed', {
          endpoint,
          state: 'CLOSED',
        });
      }
    }
  }

  /**
   * Record a failed call (may trip circuit breaker)
   */
  private recordFailure(endpoint: string, error: LLMError): void {
    let state = this.circuitBreakers.get(endpoint);
    if (!state) {
      state = { failures: 0, state: 'CLOSED' };
      this.circuitBreakers.set(endpoint, state);
    }

    state.failures++;
    state.lastFailure = new Date();

    // Check if we should open the circuit
    if (state.failures >= this.circuitBreakerThreshold && state.state !== 'OPEN') {
      state.state = 'OPEN';
      state.openedAt = new Date();
      this.logger.warn(
        `Circuit breaker for ${endpoint} OPENED after ${state.failures} failures`,
      );

      this.eventEmitter.emit('llm.circuit.state-changed', {
        endpoint,
        state: 'OPEN',
      });

      // Emit circuit breaker event
      this.eventEmitter.emit('llm.circuit.opened', {
        endpoint,
        failures: state.failures,
        lastError: error.type,
      });
    }
  }

  /**
   * Get circuit breaker status for an endpoint
   */
  getCircuitBreakerStatus(endpoint: string): CircuitBreakerState | null {
    return this.circuitBreakers.get(endpoint) || null;
  }

  /**
   * Force-open the circuit breaker for an endpoint.
   *
   * Used by higher-level routing logic to fail over quickly when an endpoint
   * is known-bad (e.g., connection refused/timeouts during a gateway restart).
   */
  openCircuit(endpoint: string, error?: LLMError): void {
    let state = this.circuitBreakers.get(endpoint);
    if (!state) {
      state = { failures: 0, state: 'CLOSED' };
      this.circuitBreakers.set(endpoint, state);
    }

    if (state.state === 'OPEN') return;

    state.failures = Math.max(state.failures, this.circuitBreakerThreshold);
    state.lastFailure = new Date();
    state.state = 'OPEN';
    state.openedAt = new Date();

    this.logger.warn(`Circuit breaker for ${endpoint} OPENED (manual trip)`);

    this.eventEmitter.emit('llm.circuit.state-changed', {
      endpoint,
      state: 'OPEN',
    });

    this.eventEmitter.emit('llm.circuit.opened', {
      endpoint,
      failures: state.failures,
      lastError: error?.type ?? LLMErrorType.UNKNOWN,
      manual: true,
    });
  }

  /**
   * Reset circuit breaker for an endpoint (for manual intervention)
   */
  resetCircuitBreaker(endpoint: string): void {
    this.circuitBreakers.delete(endpoint);
    this.logger.log(`Circuit breaker for ${endpoint} manually reset`);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
