/**
 * Database Transient Error Handling Service
 * v1.0.0: Resilience layer for transient database errors
 *
 * Purpose: Make planned or transient DB restarts boring and non-fatal.
 *
 * Key Features:
 * - Classify transient vs non-transient database errors
 * - Exponential backoff gate (5s → 60s max)
 * - Throttled logging (once per backoff window)
 * - Throttled activity events (once per minute max)
 * - Wrapper for loop ticks and pollers
 *
 * Error Patterns Detected:
 * - FATAL: the database system is shutting down
 * - FATAL: terminating connection due to administrator command
 * - ECONNRESET, ETIMEDOUT, EPIPE, ECONNREFUSED, ENOTFOUND
 * - Connection pool timeout (P2024)
 * - PrismaClientInitializationError
 * - Connection-related P1xxx errors
 *
 * @see https://www.prisma.io/docs/orm/reference/error-reference
 * @see https://advancedweb.hu/how-to-implement-an-exponential-backoff-retry-strategy-in-javascript/
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Backoff configuration
const DEFAULT_INITIAL_BACKOFF_MS = 5000;   // 5 seconds
const DEFAULT_MAX_BACKOFF_MS = 60000;      // 60 seconds
const ACTIVITY_EVENT_THROTTLE_MS = 60000;  // 1 minute between activity events

// Known transient error patterns
const TRANSIENT_ERROR_PATTERNS = [
  // PostgreSQL shutdown/admin commands
  'database system is shutting down',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
  'connection terminated',
  'the database system is starting up',
  'the database system is in recovery mode',

  // Network errors
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'socket hang up',
  'read ECONNRESET',
  'write EPIPE',

  // Connection pool issues
  'Timed out fetching a new connection from the pool',
  'Connection pool timeout',
  'pool_timeout',
  'Can\'t reach database server',
  'Unable to connect to database',
  'Connection refused',

  // Prisma-specific
  'Error querying the database',
  'Error in connector',
  'Query engine exited',
  'Prisma engine crashed',
];

// Prisma error codes that are transient (P1xxx = connection issues)
const TRANSIENT_PRISMA_CODES = [
  'P1000', // Authentication failed
  'P1001', // Can't reach database server
  'P1002', // Database server timed out
  'P1003', // Database does not exist (during migration/restart)
  'P1008', // Operations timed out
  'P1009', // Database already exists (concurrent startup)
  'P1010', // User denied access
  'P1017', // Server closed connection
  'P2024', // Connection pool timeout
];

// Error types that indicate Prisma connection issues
const TRANSIENT_ERROR_CLASSES = [
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
];

export interface DbBackoffState {
  isInBackoff: boolean;
  backoffUntil: number;
  currentBackoffMs: number;
  consecutiveTransientErrors: number;
  lastLoggedAt: number;
  lastActivityEventAt: number;
}

@Injectable()
export class DbTransientService {
  private readonly logger = new Logger(DbTransientService.name);
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  // Global backoff state
  private backoffState: DbBackoffState = {
    isInBackoff: false,
    backoffUntil: 0,
    currentBackoffMs: 0,
    consecutiveTransientErrors: 0,
    lastLoggedAt: 0,
    lastActivityEventAt: 0,
  };

  constructor(private readonly configService: ConfigService) {
    this.initialBackoffMs = parseInt(
      this.configService.get<string>('DB_TRANSIENT_INITIAL_BACKOFF_MS', String(DEFAULT_INITIAL_BACKOFF_MS)),
      10,
    );
    this.maxBackoffMs = parseInt(
      this.configService.get<string>('DB_TRANSIENT_MAX_BACKOFF_MS', String(DEFAULT_MAX_BACKOFF_MS)),
      10,
    );

    this.logger.log(
      `DbTransientService initialized (initialBackoff=${this.initialBackoffMs}ms, maxBackoff=${this.maxBackoffMs}ms)`,
    );
  }

  /**
   * Check if an error is a transient database error
   * Transient errors should trigger backoff, not crash
   */
  isDbTransient(error: any): boolean {
    if (!error) return false;

    // Check error class/constructor name
    const errorClassName = error?.constructor?.name || '';
    if (TRANSIENT_ERROR_CLASSES.some(cls => errorClassName.includes(cls))) {
      return true;
    }

    // Check Prisma error codes
    const errorCode = error?.code || '';
    if (TRANSIENT_PRISMA_CODES.includes(errorCode)) {
      return true;
    }

    // Check error message patterns
    const errorMessage = this.extractErrorMessage(error);
    const lowerMessage = errorMessage.toLowerCase();

    if (TRANSIENT_ERROR_PATTERNS.some(pattern =>
      lowerMessage.includes(pattern.toLowerCase())
    )) {
      return true;
    }

    // Check nested cause/original error
    if (error.cause && this.isDbTransient(error.cause)) {
      return true;
    }
    if (error.originalError && this.isDbTransient(error.originalError)) {
      return true;
    }

    return false;
  }

  /**
   * Extract error message from various error formats
   */
  private extractErrorMessage(error: any): string {
    if (typeof error === 'string') return error;
    if (error?.message) return String(error.message);
    if (error?.meta?.message) return String(error.meta.message);
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /**
   * Check if we're currently in a backoff period
   */
  isInBackoff(): boolean {
    if (!this.backoffState.isInBackoff) return false;

    const now = Date.now();
    if (now >= this.backoffState.backoffUntil) {
      // Backoff period expired - ready to try again
      return false;
    }

    return true;
  }

  /**
   * Get time remaining in backoff (ms)
   */
  getBackoffRemainingMs(): number {
    if (!this.isInBackoff()) return 0;
    return Math.max(0, this.backoffState.backoffUntil - Date.now());
  }

  /**
   * Get current backoff state for monitoring
   */
  getState(): DbBackoffState {
    return { ...this.backoffState };
  }

  /**
   * Record a transient database error and enter backoff
   * Returns true if we should log this occurrence (throttled)
   */
  recordTransientError(error: any): { shouldLog: boolean; shouldEmitActivity: boolean; backoffMs: number } {
    const now = Date.now();

    // Calculate new backoff duration (exponential with cap)
    if (this.backoffState.consecutiveTransientErrors === 0) {
      this.backoffState.currentBackoffMs = this.initialBackoffMs;
    } else {
      this.backoffState.currentBackoffMs = Math.min(
        this.backoffState.currentBackoffMs * 2,
        this.maxBackoffMs,
      );
    }

    this.backoffState.consecutiveTransientErrors++;
    this.backoffState.isInBackoff = true;
    this.backoffState.backoffUntil = now + this.backoffState.currentBackoffMs;

    // Determine if we should log (throttled to once per backoff window)
    const shouldLog = now - this.backoffState.lastLoggedAt >= this.backoffState.currentBackoffMs;
    if (shouldLog) {
      this.backoffState.lastLoggedAt = now;
    }

    // Determine if we should emit activity event (throttled to once per minute)
    const shouldEmitActivity = now - this.backoffState.lastActivityEventAt >= ACTIVITY_EVENT_THROTTLE_MS;
    if (shouldEmitActivity) {
      this.backoffState.lastActivityEventAt = now;
    }

    return {
      shouldLog,
      shouldEmitActivity,
      backoffMs: this.backoffState.currentBackoffMs,
    };
  }

  /**
   * Record a successful database operation - reset backoff
   */
  recordSuccess(): void {
    if (this.backoffState.consecutiveTransientErrors > 0) {
      this.logger.log(
        `Database connection recovered after ${this.backoffState.consecutiveTransientErrors} transient errors`,
      );
    }

    this.backoffState = {
      isInBackoff: false,
      backoffUntil: 0,
      currentBackoffMs: 0,
      consecutiveTransientErrors: 0,
      lastLoggedAt: this.backoffState.lastLoggedAt,
      lastActivityEventAt: this.backoffState.lastActivityEventAt,
    };
  }

  /**
   * Wrapper for async functions that should handle transient DB errors gracefully
   *
   * Usage:
   * ```typescript
   * await this.dbTransient.withTransientGuard(
   *   async () => { await this.prisma.goalRun.findMany(...) },
   *   'OrchestratorLoop.runIteration'
   * );
   * ```
   *
   * @param fn - Async function to execute
   * @param context - Context string for logging
   * @param options - Configuration options
   * @returns Result of fn, or undefined if in backoff or transient error occurred
   */
  async withTransientGuard<T>(
    fn: () => Promise<T>,
    context: string,
    options: {
      onTransientError?: (error: any, backoffMs: number) => void | Promise<void>;
      onNonTransientError?: (error: any) => void;
      skipIfInBackoff?: boolean;
    } = {},
  ): Promise<T | undefined> {
    const { onTransientError, onNonTransientError, skipIfInBackoff = true } = options;

    // Check if we're in backoff period
    if (skipIfInBackoff && this.isInBackoff()) {
      const remainingMs = this.getBackoffRemainingMs();
      this.logger.debug(
        `[${context}] Skipping - in DB backoff for ${Math.round(remainingMs / 1000)}s more`,
      );
      return undefined;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error: any) {
      if (this.isDbTransient(error)) {
        const { shouldLog, shouldEmitActivity, backoffMs } = this.recordTransientError(error);

        if (shouldLog) {
          this.logger.warn(
            `[${context}] Transient DB error (backoff ${Math.round(backoffMs / 1000)}s, ` +
            `consecutive: ${this.backoffState.consecutiveTransientErrors}): ${this.extractErrorMessage(error)}`,
          );
        }

        if (onTransientError) {
          try {
            await onTransientError(error, backoffMs);
          } catch (callbackError) {
            // Don't let callback errors propagate
            this.logger.debug(`[${context}] onTransientError callback failed: ${callbackError}`);
          }
        }

        return undefined;
      }

      // Non-transient error - propagate it
      if (onNonTransientError) {
        onNonTransientError(error);
      }
      throw error;
    }
  }

  /**
   * Check if we should emit a DB unavailable activity event
   * Throttled to once per minute
   */
  shouldEmitDbUnavailableActivity(): boolean {
    const now = Date.now();
    return now - this.backoffState.lastActivityEventAt >= ACTIVITY_EVENT_THROTTLE_MS;
  }

  /**
   * Mark that we emitted a DB unavailable activity event
   */
  markActivityEmitted(): void {
    this.backoffState.lastActivityEventAt = Date.now();
  }
}
