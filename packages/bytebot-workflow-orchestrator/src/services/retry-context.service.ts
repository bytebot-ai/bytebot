/**
 * Retry Context Service
 * v1.0.0: Nice-to-Have Enhancement for Intelligent Retry with Context
 *
 * Implements retry logic that preserves and enhances context across attempts:
 * - Captures error details from failed attempts
 * - Builds enriched context for AI agent on retry
 * - Classifies errors as retriable vs non-retriable
 * - Provides suggested adjustments based on failure patterns
 *
 * Uses Cockatiel for retry policies with custom backoff.
 *
 * @see /docs/CONTEXT_PROPAGATION_FIX_JAN_2026.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  retry,
  handleWhen,
  DelegateBackoff,
  IRetryContext,
} from 'cockatiel';

// Retry attempt information
export interface RetryAttemptInfo {
  attemptNumber: number;
  previousError: Error;
  errorType: string;
  errorMessage: string;
  errorClassification: 'retriable' | 'non-retriable' | 'unknown';
  timestamp: Date;
  backoffMs: number;
}

// Task context for retry
export interface TaskRetryContext {
  taskId: string;
  goalRunId: string;
  checklistItemId: string;
  stepDescription: string;
  goalContext?: string;
  previousStepResults?: string;
}

// Enhanced context after retry processing
export interface EnhancedRetryContext extends TaskRetryContext {
  retryHistory: RetryAttemptInfo[];
  isRetry: boolean;
  totalAttempts: number;
  suggestedAdjustments: string[];
  retryContextSummary: string;
}

// Retry result
export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: number;
  retryHistory: RetryAttemptInfo[];
}

// Error classification result
export interface ErrorClassification {
  classification: 'retriable' | 'non-retriable' | 'unknown';
  reason: string;
  suggestedAction: 'retry' | 'escalate' | 'fail';
  retryDelayMs?: number;
}

// Retry configuration
interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

@Injectable()
export class RetryContextService {
  private readonly logger = new Logger(RetryContextService.name);

  // Default retry configuration
  private readonly retryConfig: RetryConfig;

  // Retry history per task (keyed by taskId)
  private readonly retryHistories: Map<string, RetryAttemptInfo[]> = new Map();

  // Error patterns for classification
  private readonly retriablePatterns: RegExp[] = [
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /ECONNREFUSED/i,
    /rate limit/i,
    /503/,
    /502/,
    /504/,
    /429/,
    /timeout/i,
    /temporarily unavailable/i,
    /service unavailable/i,
    /connection refused/i,
    /network error/i,
  ];

  private readonly nonRetriablePatterns: RegExp[] = [
    /validation error/i,
    /invalid input/i,
    /permission denied/i,
    /unauthorized/i,
    /forbidden/i,
    /not found/i,
    /400/,
    /401/,
    /403/,
    /404/,
    /syntax error/i,
    /invalid request/i,
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.retryConfig = {
      maxAttempts: parseInt(
        this.configService.get('RETRY_MAX_ATTEMPTS', '3'),
        10,
      ),
      initialDelayMs: parseInt(
        this.configService.get('RETRY_INITIAL_DELAY_MS', '1000'),
        10,
      ),
      maxDelayMs: parseInt(
        this.configService.get('RETRY_MAX_DELAY_MS', '30000'),
        10,
      ),
      jitterFactor: parseFloat(
        this.configService.get('RETRY_JITTER_FACTOR', '0.3'),
      ),
    };

    this.logger.log(
      `Retry config: max=${this.retryConfig.maxAttempts}, ` +
      `initial=${this.retryConfig.initialDelayMs}ms, ` +
      `max=${this.retryConfig.maxDelayMs}ms`,
    );
  }

  /**
   * Execute a function with intelligent retry and context enhancement
   *
   * This wraps the provided function in a retry policy that:
   * 1. Classifies errors to determine if retry is appropriate
   * 2. Records retry history for context enhancement
   * 3. Uses exponential backoff with jitter
   * 4. Generates suggested adjustments for the AI agent
   */
  async executeWithRetry<T>(
    context: TaskRetryContext,
    fn: (enhancedContext: EnhancedRetryContext) => Promise<T>,
    options?: Partial<RetryConfig>,
  ): Promise<RetryResult<T>> {
    const config = { ...this.retryConfig, ...options };
    const retryHistory: RetryAttemptInfo[] = [];

    // Create error handler that only retries retriable errors
    const errorHandler = handleWhen((error: unknown) => {
      const classification = this.classifyError(error as Error);
      return classification.classification === 'retriable';
    });

    // Create retry policy with context-aware backoff
    const retryPolicy = retry(errorHandler, {
      maxAttempts: config.maxAttempts,
      backoff: new DelegateBackoff((retryContext) => {
        // Cockatiel v3 uses `error` instead of `result`
        const error = (retryContext as any).error as Error || new Error('Unknown error');
        const classification = this.classifyError(error);

        // Calculate backoff with jitter
        const backoffMs = this.calculateBackoff(
          retryContext.attempt,
          config,
          classification,
        );

        // Record this attempt
        const attemptInfo: RetryAttemptInfo = {
          attemptNumber: retryContext.attempt,
          previousError: error,
          errorType: error.constructor.name,
          errorMessage: error.message,
          errorClassification: classification.classification,
          timestamp: new Date(),
          backoffMs,
        };
        retryHistory.push(attemptInfo);

        this.logger.warn(
          `Retry ${retryContext.attempt}/${config.maxAttempts} for task ${context.taskId}: ` +
          `${error.message} (backing off ${backoffMs}ms)`,
        );

        // Emit event for monitoring
        this.eventEmitter.emit('retry.attempt', {
          taskId: context.taskId,
          goalRunId: context.goalRunId,
          attempt: retryContext.attempt,
          error: error.message,
          classification: classification.classification,
          backoffMs,
        });

        return backoffMs;
      }),
    });

    // Subscribe to retry events for logging
    const retryListener = retryPolicy.onRetry((data) => {
      this.logger.debug(`Retry triggered for task ${context.taskId}`);
    });

    const giveUpListener = retryPolicy.onGiveUp((data) => {
      // Cockatiel v3 uses `error` instead of `reason`
      const errorMessage = (data as any).error?.message || (data as any).reason?.message || 'Unknown error';
      this.logger.error(
        `Giving up on task ${context.taskId} after ${config.maxAttempts} attempts: ${errorMessage}`,
      );
    });

    try {
      // Execute with retry policy
      const result = await retryPolicy.execute(async ({ attempt }) => {
        // Build enhanced context with retry information
        const enhancedContext = this.enhanceContextForRetry(
          context,
          retryHistory,
          attempt,
        );

        return await fn(enhancedContext);
      });

      // Store successful retry history
      this.retryHistories.set(context.taskId, retryHistory);

      return {
        success: true,
        result,
        attempts: retryHistory.length + 1,
        retryHistory,
      };
    } catch (error) {
      // Store failed retry history
      this.retryHistories.set(context.taskId, retryHistory);

      this.eventEmitter.emit('retry.exhausted', {
        taskId: context.taskId,
        goalRunId: context.goalRunId,
        attempts: retryHistory.length,
        finalError: (error as Error).message,
      });

      return {
        success: false,
        error: error as Error,
        attempts: retryHistory.length + 1,
        retryHistory,
      };
    } finally {
      retryListener.dispose();
      giveUpListener.dispose();
    }
  }

  /**
   * Classify an error as retriable or not
   */
  classifyError(error: Error): ErrorClassification {
    const message = error.message || '';
    const name = error.name || '';
    const combined = `${name}: ${message}`;

    // Check non-retriable patterns first (more specific)
    for (const pattern of this.nonRetriablePatterns) {
      if (pattern.test(combined)) {
        return {
          classification: 'non-retriable',
          reason: `Error matches non-retriable pattern: ${pattern}`,
          suggestedAction: 'fail',
        };
      }
    }

    // Check retriable patterns
    for (const pattern of this.retriablePatterns) {
      if (pattern.test(combined)) {
        // Check for rate limit with Retry-After
        const retryAfterMatch = message.match(/retry.after[:\s]*(\d+)/i);
        const retryDelayMs = retryAfterMatch
          ? parseInt(retryAfterMatch[1], 10) * 1000
          : undefined;

        return {
          classification: 'retriable',
          reason: `Error matches retriable pattern: ${pattern}`,
          suggestedAction: 'retry',
          retryDelayMs,
        };
      }
    }

    // Default: unknown, retry with caution
    return {
      classification: 'unknown',
      reason: 'Error does not match known patterns',
      suggestedAction: 'retry',
    };
  }

  /**
   * Enhance context with retry information for AI agent
   */
  enhanceContextForRetry(
    context: TaskRetryContext,
    retryHistory: RetryAttemptInfo[],
    currentAttempt: number,
  ): EnhancedRetryContext {
    const suggestedAdjustments = this.generateSuggestedAdjustments(retryHistory);
    const retryContextSummary = this.buildRetryContextSummary(retryHistory);

    return {
      ...context,
      retryHistory,
      isRetry: retryHistory.length > 0,
      totalAttempts: currentAttempt,
      suggestedAdjustments,
      retryContextSummary,
    };
  }

  /**
   * Get retry history for a task
   */
  getRetryHistory(taskId: string): RetryAttemptInfo[] {
    return this.retryHistories.get(taskId) || [];
  }

  /**
   * Clear retry history for a task (after completion)
   */
  clearRetryHistory(taskId: string): void {
    this.retryHistories.delete(taskId);
  }

  /**
   * Build a summary string for AI context enhancement
   */
  buildRetryContextSummary(retryHistory: RetryAttemptInfo[]): string {
    if (retryHistory.length === 0) {
      return '';
    }

    const parts: string[] = [
      `--- RETRY CONTEXT (Attempt ${retryHistory.length + 1}) ---`,
      `Previous attempts: ${retryHistory.length}`,
    ];

    // Summarize error types
    const errorTypes = [...new Set(retryHistory.map((r) => r.errorType))];
    parts.push(`Error types encountered: ${errorTypes.join(', ')}`);

    // Last error details
    const lastError = retryHistory[retryHistory.length - 1];
    parts.push(`Last error: ${lastError.errorMessage.slice(0, 200)}`);

    parts.push('--- END RETRY CONTEXT ---');

    return parts.join('\n');
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Calculate backoff delay with jitter
   */
  private calculateBackoff(
    attempt: number,
    config: RetryConfig,
    classification: ErrorClassification,
  ): number {
    // Respect Retry-After header if present
    if (classification.retryDelayMs) {
      return classification.retryDelayMs;
    }

    // Exponential backoff with full jitter
    // Full jitter: random value between 0 and exponential delay
    const exponentialDelay = Math.min(
      config.initialDelayMs * Math.pow(2, attempt - 1),
      config.maxDelayMs,
    );

    // Apply jitter (random factor of the delay)
    const jitter = Math.random() * config.jitterFactor * exponentialDelay;
    const jitteredDelay = Math.random() * exponentialDelay; // Full jitter

    return Math.round(Math.min(jitteredDelay + jitter, config.maxDelayMs));
  }

  /**
   * Generate suggested adjustments based on error patterns
   */
  private generateSuggestedAdjustments(
    retryHistory: RetryAttemptInfo[],
  ): string[] {
    const suggestions: string[] = [];
    const errorTypes = retryHistory.map((r) => r.errorType);
    const errorMessages = retryHistory.map((r) => r.errorMessage);

    // Analyze error patterns and suggest adjustments
    if (errorTypes.includes('TimeoutError') || errorMessages.some((m) => /timeout/i.test(m))) {
      suggestions.push('Consider breaking the task into smaller sub-tasks');
      suggestions.push('Reduce complexity of the operation');
    }

    if (errorMessages.some((m) => /rate limit/i.test(m) || /429/.test(m))) {
      suggestions.push('Reduce API call frequency');
      suggestions.push('Batch operations where possible');
    }

    if (errorMessages.some((m) => /network/i.test(m) || /connection/i.test(m))) {
      suggestions.push('Previous attempts encountered network issues');
      suggestions.push('Consider simpler approaches that require fewer external calls');
    }

    if (errorMessages.some((m) => /element not found/i.test(m) || /selector/i.test(m))) {
      suggestions.push('UI elements may have changed - try alternative selectors');
      suggestions.push('Wait for page to fully load before interacting');
    }

    // Add summary of previous errors for AI understanding
    if (retryHistory.length > 0) {
      const uniqueErrors = [...new Set(errorMessages)].slice(0, 3);
      suggestions.push(`Previous error(s): ${uniqueErrors.join('; ')}`);
    }

    return suggestions;
  }
}
