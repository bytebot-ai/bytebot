/**
 * Failure Classification Service
 * v1.0.0: Google-style Failure Classification (Option C Industry Standard)
 *
 * Implements a hierarchical failure classification system following Google's
 * SRE practices for distinguishing between transient and permanent failures.
 *
 * Failure Types:
 * - TRANSIENT: Temporary issues that may resolve with retry (network, heartbeat)
 * - SEMANTIC: Task logic failures requiring replanning (wrong approach)
 * - PERMANENT: Unrecoverable failures requiring immediate termination
 *
 * This service enables:
 * - Separate retry budgets for different failure types
 * - Intelligent escalation paths (transient → semantic → permanent)
 * - Error preservation for diagnostics (Manus-style)
 * - Checkpoint/resume support (Anthropic-style)
 *
 * @see docs/OPTION_C_INDUSTRY_STANDARD_FIX.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// =============================================================================
// Failure Classification Types
// =============================================================================

/**
 * Failure category hierarchy (Google SRE pattern)
 */
export enum FailureCategory {
  /**
   * Transient failures - temporary issues that may self-resolve
   * Examples: network timeout, heartbeat gap, service unavailable
   * Action: Retry with exponential backoff
   */
  TRANSIENT = 'TRANSIENT',

  /**
   * Semantic failures - task logic or approach failures
   * Examples: wrong selector, invalid input, assertion failed
   * Action: Replan with alternative approach
   */
  SEMANTIC = 'SEMANTIC',

  /**
   * Permanent failures - unrecoverable issues
   * Examples: resource deleted, permission denied, budget exhausted
   * Action: Fail immediately with diagnostic info
   */
  PERMANENT = 'PERMANENT',
}

/**
 * Specific failure type within a category
 */
export enum FailureType {
  // Transient failures
  HEARTBEAT_TIMEOUT = 'HEARTBEAT_TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  RESOURCE_CONTENTION = 'RESOURCE_CONTENTION',
  CAPACITY_EXHAUSTED = 'CAPACITY_EXHAUSTED',
  AGENT_UNREACHABLE = 'AGENT_UNREACHABLE',

  // Semantic failures
  STEP_FAILED = 'STEP_FAILED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  ASSERTION_FAILED = 'ASSERTION_FAILED',
  NEEDS_HELP = 'NEEDS_HELP',
  WRONG_APPROACH = 'WRONG_APPROACH',

  // Permanent failures
  RESOURCE_DELETED = 'RESOURCE_DELETED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED',
  GOAL_CANCELLED = 'GOAL_CANCELLED',
  FATAL_ERROR = 'FATAL_ERROR',

  // Unknown (default)
  UNKNOWN = 'UNKNOWN',
}

/**
 * Complete failure classification result
 */
export interface FailureClassification {
  category: FailureCategory;
  type: FailureType;
  isRetryable: boolean;
  isReplannable: boolean;
  suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
  reasoning: string;
  diagnosticInfo: DiagnosticInfo;
}

/**
 * Diagnostic information for error preservation (Manus-style)
 */
export interface DiagnosticInfo {
  timestamp: Date;
  errorMessage: string;
  errorCode?: string;
  stackTrace?: string;
  context: Record<string, any>;
  previousAttempts: AttemptRecord[];
  suggestedRecovery?: string;
}

/**
 * Record of a previous attempt (for error preservation)
 */
export interface AttemptRecord {
  attemptNumber: number;
  timestamp: Date;
  failureType: FailureType;
  errorMessage: string;
  duration?: number;
}

/**
 * Retry budget tracking per failure type
 */
export interface RetryBudget {
  maxRetries: number;
  currentRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  lastRetryAt?: Date;
  nextRetryAt?: Date;
}

// =============================================================================
// Service Implementation
// =============================================================================

@Injectable()
export class FailureClassificationService {
  private readonly logger = new Logger(FailureClassificationService.name);

  // Retry budgets per checklist item and failure category
  // Key: `${checklistItemId}:${FailureCategory}`
  private readonly retryBudgets = new Map<string, RetryBudget>();

  // Error history per checklist item (Manus-style preservation)
  // Key: checklistItemId
  private readonly errorHistory = new Map<string, AttemptRecord[]>();

  // Default retry configuration
  private readonly defaults: {
    transientMaxRetries: number;
    semanticMaxRetries: number;
    heartbeatMaxRetries: number;
    transientBaseDelayMs: number;
    transientMaxDelayMs: number;
    heartbeatBaseDelayMs: number;
    heartbeatMaxDelayMs: number;
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.defaults = {
      // Transient failures get more retries (infrastructure is usually flaky temporarily)
      transientMaxRetries: parseInt(
        this.configService.get('TRANSIENT_MAX_RETRIES', '5'),
        10,
      ),
      // Semantic failures get replan attempts (already tracked by orchestrator)
      semanticMaxRetries: parseInt(
        this.configService.get('SEMANTIC_MAX_RETRIES', '3'),
        10,
      ),
      // Heartbeat timeouts get their own budget (separate from infra failures)
      heartbeatMaxRetries: parseInt(
        this.configService.get('HEARTBEAT_MAX_RETRIES', '5'),
        10,
      ),
      // Transient retry delays
      transientBaseDelayMs: parseInt(
        this.configService.get('TRANSIENT_BASE_DELAY_MS', '10000'),
        10,
      ),
      transientMaxDelayMs: parseInt(
        this.configService.get('TRANSIENT_MAX_DELAY_MS', '120000'),
        10,
      ),
      // Heartbeat retry delays (shorter, as agent might recover quickly)
      heartbeatBaseDelayMs: parseInt(
        this.configService.get('HEARTBEAT_BASE_DELAY_MS', '15000'),
        10,
      ),
      heartbeatMaxDelayMs: parseInt(
        this.configService.get('HEARTBEAT_MAX_DELAY_MS', '60000'),
        10,
      ),
    };

    this.logger.log(
      `FailureClassificationService initialized ` +
      `(transient: ${this.defaults.transientMaxRetries} retries, ` +
      `heartbeat: ${this.defaults.heartbeatMaxRetries} retries, ` +
      `semantic: ${this.defaults.semanticMaxRetries} replans)`,
    );
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Classify a failure and determine the appropriate action
   *
   * @param itemId - Checklist item ID
   * @param errorMessage - Error message or outcome
   * @param context - Additional context for classification
   * @returns Classification result with suggested action
   */
  classifyFailure(
    itemId: string,
    errorMessage: string,
    context: Record<string, any> = {},
  ): FailureClassification {
    const type = this.detectFailureType(errorMessage, context);
    const category = this.getCategory(type);

    // Get or create retry budget for this item+category
    const budgetKey = `${itemId}:${category}`;
    let budget = this.retryBudgets.get(budgetKey);
    if (!budget) {
      budget = this.createBudget(category, type);
      this.retryBudgets.set(budgetKey, budget);
    }

    // Record this attempt in error history
    this.recordAttempt(itemId, type, errorMessage);

    // Determine if we can retry/replan based on budget
    const isRetryable = category === FailureCategory.TRANSIENT &&
      budget.currentRetries < budget.maxRetries;
    const isReplannable = category === FailureCategory.SEMANTIC;

    // Determine suggested action
    let suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
    let reasoning: string;

    if (category === FailureCategory.PERMANENT) {
      suggestedAction = 'FAIL';
      reasoning = `Permanent failure (${type}): cannot recover`;
    } else if (category === FailureCategory.TRANSIENT) {
      if (isRetryable) {
        suggestedAction = 'RETRY';
        reasoning = `Transient failure (${type}): retry ${budget.currentRetries + 1}/${budget.maxRetries}`;
      } else {
        // Exhausted transient retries - escalate to replan
        suggestedAction = 'REPLAN';
        reasoning = `Transient retries exhausted (${budget.maxRetries}): escalating to replan`;
      }
    } else {
      // Semantic failure
      suggestedAction = 'REPLAN';
      reasoning = `Semantic failure (${type}): requires replanning`;
    }

    const classification: FailureClassification = {
      category,
      type,
      isRetryable,
      isReplannable,
      suggestedAction,
      reasoning,
      diagnosticInfo: this.buildDiagnosticInfo(itemId, errorMessage, context),
    };

    // Emit event for observability
    this.eventEmitter.emit('failure.classified', {
      itemId,
      classification: {
        category,
        type,
        suggestedAction,
        retryCount: budget.currentRetries,
      },
    });

    this.logger.log(
      `Classified failure for ${itemId}: ${category}/${type} → ${suggestedAction}`,
    );

    return classification;
  }

  /**
   * Classify a heartbeat timeout specifically
   * This has its own retry budget separate from other transient failures
   */
  classifyHeartbeatTimeout(
    itemId: string,
    consecutiveUnhealthy: number,
    lastHeartbeat: Date | null,
    context: Record<string, any> = {},
  ): FailureClassification {
    const type = FailureType.HEARTBEAT_TIMEOUT;
    const category = FailureCategory.TRANSIENT;

    // Use heartbeat-specific budget key
    const budgetKey = `${itemId}:HEARTBEAT`;
    let budget = this.retryBudgets.get(budgetKey);
    if (!budget) {
      budget = {
        maxRetries: this.defaults.heartbeatMaxRetries,
        currentRetries: 0,
        baseDelayMs: this.defaults.heartbeatBaseDelayMs,
        maxDelayMs: this.defaults.heartbeatMaxDelayMs,
      };
      this.retryBudgets.set(budgetKey, budget);
    }

    const errorMessage = `Heartbeat timeout: ${consecutiveUnhealthy} consecutive unhealthy checks, ` +
      `last heartbeat: ${lastHeartbeat?.toISOString() || 'never'}`;

    // Record this attempt
    this.recordAttempt(itemId, type, errorMessage);

    const isRetryable = budget.currentRetries < budget.maxRetries;

    let suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
    let reasoning: string;

    if (isRetryable) {
      suggestedAction = 'RETRY';
      reasoning = `Heartbeat timeout: retry ${budget.currentRetries + 1}/${budget.maxRetries} ` +
        `(agent may recover)`;
    } else {
      // Exhausted heartbeat retries - escalate to replan
      suggestedAction = 'REPLAN';
      reasoning = `Heartbeat retries exhausted (${budget.maxRetries}): agent not responding, ` +
        `escalating to replan`;
    }

    const classification: FailureClassification = {
      category,
      type,
      isRetryable,
      isReplannable: true,
      suggestedAction,
      reasoning,
      diagnosticInfo: this.buildDiagnosticInfo(itemId, errorMessage, {
        ...context,
        consecutiveUnhealthy,
        lastHeartbeat,
        heartbeatRetries: budget.currentRetries,
      }),
    };

    this.logger.log(
      `Classified heartbeat timeout for ${itemId}: ${suggestedAction} ` +
      `(${budget.currentRetries}/${budget.maxRetries} retries used)`,
    );

    return classification;
  }

  /**
   * Consume one retry from the budget and calculate delay
   *
   * @returns Retry delay in milliseconds, or null if budget exhausted
   */
  consumeRetry(
    itemId: string,
    category: FailureCategory | 'HEARTBEAT',
  ): { delayMs: number; retryCount: number } | null {
    const budgetKey = `${itemId}:${category}`;
    const budget = this.retryBudgets.get(budgetKey);

    if (!budget || budget.currentRetries >= budget.maxRetries) {
      return null;
    }

    budget.currentRetries++;
    budget.lastRetryAt = new Date();

    // Calculate exponential backoff with jitter
    const exponentialDelay = budget.baseDelayMs * Math.pow(2, budget.currentRetries - 1);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
    const delayMs = Math.min(exponentialDelay + jitter, budget.maxDelayMs);

    budget.nextRetryAt = new Date(Date.now() + delayMs);

    this.logger.debug(
      `Consumed retry ${budget.currentRetries}/${budget.maxRetries} for ${itemId}:${category}, ` +
      `delay: ${Math.round(delayMs / 1000)}s`,
    );

    return {
      delayMs,
      retryCount: budget.currentRetries,
    };
  }

  /**
   * Get current retry status for an item
   */
  getRetryStatus(
    itemId: string,
    category: FailureCategory | 'HEARTBEAT',
  ): RetryBudget | null {
    const budgetKey = `${itemId}:${category}`;
    return this.retryBudgets.get(budgetKey) || null;
  }

  /**
   * Get error history for an item (Manus-style error preservation)
   */
  getErrorHistory(itemId: string): AttemptRecord[] {
    return this.errorHistory.get(itemId) || [];
  }

  /**
   * Clear retry budgets and error history for an item
   * Call this when a step succeeds or is skipped
   */
  clearItemTracking(itemId: string): void {
    // Clear all budget keys for this item
    for (const key of this.retryBudgets.keys()) {
      if (key.startsWith(`${itemId}:`)) {
        this.retryBudgets.delete(key);
      }
    }
    this.errorHistory.delete(itemId);
    this.logger.debug(`Cleared tracking for item ${itemId}`);
  }

  /**
   * Clear all tracking for a goal run
   * Call this when a goal run completes or fails
   */
  clearGoalRunTracking(goalRunId: string, itemIds: string[]): void {
    for (const itemId of itemIds) {
      this.clearItemTracking(itemId);
    }
    this.logger.debug(`Cleared tracking for goal run ${goalRunId}`);
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Detect failure type from error message and context
   */
  private detectFailureType(
    errorMessage: string,
    context: Record<string, any>,
  ): FailureType {
    const msg = errorMessage.toLowerCase();

    // Check for explicit type markers
    if (context.failureType) {
      return context.failureType as FailureType;
    }

    // Heartbeat timeout patterns
    if (
      msg.includes('heartbeat') ||
      msg.includes('consecutive unhealthy') ||
      msg.includes('heartbeat stopped')
    ) {
      return FailureType.HEARTBEAT_TIMEOUT;
    }

    // Network error patterns
    if (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('enotfound') ||
      msg.includes('socket hang up') ||
      msg.includes('network error') ||
      msg.includes('fetch failed')
    ) {
      return FailureType.NETWORK_ERROR;
    }

    // Service unavailable patterns
    if (
      msg.includes('503') ||
      msg.includes('service unavailable') ||
      msg.includes('temporarily unavailable')
    ) {
      return FailureType.SERVICE_UNAVAILABLE;
    }

    // Agent unreachable patterns
    if (
      msg.includes('agent unreachable') ||
      msg.includes('task not found') ||
      msg.includes('404') ||
      msg.includes('[infra]')
    ) {
      return FailureType.AGENT_UNREACHABLE;
    }

    // Capacity patterns
    if (
      msg.includes('capacity') ||
      msg.includes('no available') ||
      msg.includes('pool exhausted')
    ) {
      return FailureType.CAPACITY_EXHAUSTED;
    }

    // Resource contention patterns
    if (
      msg.includes('workspace not ready') ||
      msg.includes('resource busy') ||
      msg.includes('lock')
    ) {
      return FailureType.RESOURCE_CONTENTION;
    }

    // Permission denied (permanent)
    if (
      msg.includes('permission denied') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('403')
    ) {
      return FailureType.PERMISSION_DENIED;
    }

    // Resource deleted (permanent)
    if (
      msg.includes('not found') &&
      (msg.includes('deleted') || msg.includes('no longer exists'))
    ) {
      return FailureType.RESOURCE_DELETED;
    }

    // Budget exhausted (permanent)
    if (
      msg.includes('budget') ||
      msg.includes('quota') ||
      msg.includes('limit exceeded')
    ) {
      return FailureType.BUDGET_EXHAUSTED;
    }

    // NEEDS_HELP pattern (semantic)
    if (
      msg.includes('needs_help') ||
      msg.includes('needs help') ||
      msg.includes('user intervention')
    ) {
      return FailureType.NEEDS_HELP;
    }

    // Validation error (semantic)
    if (
      msg.includes('validation') ||
      msg.includes('invalid') ||
      msg.includes('malformed')
    ) {
      return FailureType.VALIDATION_ERROR;
    }

    // Default to step failed (semantic)
    return FailureType.STEP_FAILED;
  }

  /**
   * Get category for a failure type
   */
  private getCategory(type: FailureType): FailureCategory {
    switch (type) {
      // Transient failures
      case FailureType.HEARTBEAT_TIMEOUT:
      case FailureType.NETWORK_ERROR:
      case FailureType.SERVICE_UNAVAILABLE:
      case FailureType.RESOURCE_CONTENTION:
      case FailureType.CAPACITY_EXHAUSTED:
      case FailureType.AGENT_UNREACHABLE:
        return FailureCategory.TRANSIENT;

      // Permanent failures
      case FailureType.RESOURCE_DELETED:
      case FailureType.PERMISSION_DENIED:
      case FailureType.BUDGET_EXHAUSTED:
      case FailureType.GOAL_CANCELLED:
      case FailureType.FATAL_ERROR:
        return FailureCategory.PERMANENT;

      // Semantic failures (default)
      case FailureType.STEP_FAILED:
      case FailureType.VALIDATION_ERROR:
      case FailureType.ASSERTION_FAILED:
      case FailureType.NEEDS_HELP:
      case FailureType.WRONG_APPROACH:
      case FailureType.UNKNOWN:
      default:
        return FailureCategory.SEMANTIC;
    }
  }

  /**
   * Create a retry budget for a category
   */
  private createBudget(
    category: FailureCategory,
    type: FailureType,
  ): RetryBudget {
    if (type === FailureType.HEARTBEAT_TIMEOUT) {
      return {
        maxRetries: this.defaults.heartbeatMaxRetries,
        currentRetries: 0,
        baseDelayMs: this.defaults.heartbeatBaseDelayMs,
        maxDelayMs: this.defaults.heartbeatMaxDelayMs,
      };
    }

    if (category === FailureCategory.TRANSIENT) {
      return {
        maxRetries: this.defaults.transientMaxRetries,
        currentRetries: 0,
        baseDelayMs: this.defaults.transientBaseDelayMs,
        maxDelayMs: this.defaults.transientMaxDelayMs,
      };
    }

    // Semantic failures don't use retry budget (they use replan budget)
    return {
      maxRetries: 0,
      currentRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
  }

  /**
   * Record an attempt in error history (Manus-style preservation)
   */
  private recordAttempt(
    itemId: string,
    type: FailureType,
    errorMessage: string,
  ): void {
    let history = this.errorHistory.get(itemId);
    if (!history) {
      history = [];
      this.errorHistory.set(itemId, history);
    }

    history.push({
      attemptNumber: history.length + 1,
      timestamp: new Date(),
      failureType: type,
      errorMessage,
    });

    // Keep only last 10 attempts to avoid memory bloat
    if (history.length > 10) {
      history.shift();
    }
  }

  /**
   * Build diagnostic info for error preservation
   */
  private buildDiagnosticInfo(
    itemId: string,
    errorMessage: string,
    context: Record<string, any>,
  ): DiagnosticInfo {
    const previousAttempts = this.getErrorHistory(itemId);

    // Generate suggested recovery based on error patterns
    let suggestedRecovery: string | undefined;
    if (previousAttempts.length >= 3) {
      const failureTypes = previousAttempts.map((a) => a.failureType);
      const allSameType = failureTypes.every((t) => t === failureTypes[0]);
      if (allSameType) {
        suggestedRecovery = `Repeated ${failureTypes[0]} failures. Consider: ` +
          `1) Checking infrastructure status, 2) Reducing concurrency, ` +
          `3) Manual intervention.`;
      }
    }

    return {
      timestamp: new Date(),
      errorMessage,
      errorCode: context.errorCode,
      stackTrace: context.stackTrace,
      context,
      previousAttempts,
      suggestedRecovery,
    };
  }
}
