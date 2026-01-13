/**
 * Idempotency Service
 * v1.0.0 M5: Ensures high-risk actions execute exactly once
 *
 * Best Practices Applied:
 * - Unique idempotency keys (nodeRunId + actionHash)
 * - Database-level uniqueness constraints
 * - Status tracking (PROCESSING, COMPLETED, FAILED)
 * - TTL-based cleanup for expired records
 * - Cached results for duplicate requests
 *
 * References:
 * - https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
 * - https://microservices.io/patterns/communication-style/idempotent-consumer.html
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

/**
 * Idempotency record status
 */
export enum IdempotencyStatus {
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/**
 * Idempotency check result
 */
export interface IdempotencyCheckResult {
  isNew: boolean;
  status: IdempotencyStatus;
  result?: any;
  errorMessage?: string;
  recordId?: string;
}

/**
 * Execution result to store
 */
export interface ExecutionResult {
  success: boolean;
  result?: any;
  errorMessage?: string;
}

/**
 * Default TTL for idempotency records in hours
 */
const DEFAULT_IDEMPOTENCY_TTL_HOURS = 24;

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly ttlHours: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.ttlHours = parseInt(
      this.configService.get<string>(
        'IDEMPOTENCY_TTL_HOURS',
        String(DEFAULT_IDEMPOTENCY_TTL_HOURS),
      ),
      10,
    );

    this.logger.log(`Idempotency TTL: ${this.ttlHours} hours`);
  }

  /**
   * Generate idempotency key from node run ID and action hash
   */
  generateKey(nodeRunId: string, actionHash: string): string {
    return `${nodeRunId}:${actionHash}`;
  }

  /**
   * Check if an action can be executed (acquire idempotency lock)
   *
   * Returns:
   * - isNew: true if this is a new action that can be executed
   * - status: current status if already exists
   * - result: cached result if COMPLETED
   */
  async checkAndAcquire(
    nodeRunId: string,
    actionHash: string,
  ): Promise<IdempotencyCheckResult> {
    const idempotencyKey = this.generateKey(nodeRunId, actionHash);
    const expiresAt = new Date(Date.now() + this.ttlHours * 60 * 60 * 1000);

    try {
      // Try to create a new record (will fail if key exists due to unique constraint)
      const record = await this.prisma.idempotencyRecord.create({
        data: {
          idempotencyKey,
          actionHash,
          status: IdempotencyStatus.PROCESSING,
          expiresAt,
        },
      });

      this.logger.debug(`Created idempotency record: ${record.id} for key ${idempotencyKey}`);

      return {
        isNew: true,
        status: IdempotencyStatus.PROCESSING,
        recordId: record.id,
      };
    } catch (error: any) {
      // P2002 is Prisma's unique constraint violation
      if (error.code === 'P2002') {
        // Record already exists - check its status
        const existing = await this.prisma.idempotencyRecord.findUnique({
          where: { idempotencyKey },
        });

        if (!existing) {
          // Race condition - try again
          this.logger.warn(`Idempotency race condition for key ${idempotencyKey}, retrying`);
          return this.checkAndAcquire(nodeRunId, actionHash);
        }

        this.logger.debug(
          `Idempotency key ${idempotencyKey} exists with status ${existing.status}`,
        );

        return {
          isNew: false,
          status: existing.status as IdempotencyStatus,
          result: existing.result as any,
          errorMessage: existing.errorMessage || undefined,
          recordId: existing.id,
        };
      }

      throw error;
    }
  }

  /**
   * Mark action as completed with result
   */
  async markCompleted(
    nodeRunId: string,
    actionHash: string,
    result: any,
  ): Promise<void> {
    const idempotencyKey = this.generateKey(nodeRunId, actionHash);

    await this.prisma.idempotencyRecord.update({
      where: { idempotencyKey },
      data: {
        status: IdempotencyStatus.COMPLETED,
        result,
        completedAt: new Date(),
      },
    });

    this.logger.debug(`Marked idempotency key ${idempotencyKey} as COMPLETED`);
  }

  /**
   * Mark action as failed with error
   */
  async markFailed(
    nodeRunId: string,
    actionHash: string,
    errorMessage: string,
  ): Promise<void> {
    const idempotencyKey = this.generateKey(nodeRunId, actionHash);

    await this.prisma.idempotencyRecord.update({
      where: { idempotencyKey },
      data: {
        status: IdempotencyStatus.FAILED,
        errorMessage,
        completedAt: new Date(),
      },
    });

    this.logger.debug(`Marked idempotency key ${idempotencyKey} as FAILED: ${errorMessage}`);
  }

  /**
   * Get idempotency record by key
   */
  async getRecord(
    nodeRunId: string,
    actionHash: string,
  ): Promise<{
    id: string;
    status: IdempotencyStatus;
    result?: any;
    errorMessage?: string;
    createdAt: Date;
    completedAt?: Date;
  } | null> {
    const idempotencyKey = this.generateKey(nodeRunId, actionHash);

    const record = await this.prisma.idempotencyRecord.findUnique({
      where: { idempotencyKey },
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      status: record.status as IdempotencyStatus,
      result: record.result as any,
      errorMessage: record.errorMessage || undefined,
      createdAt: record.createdAt,
      completedAt: record.completedAt || undefined,
    };
  }

  /**
   * Execute an action with idempotency guarantee
   *
   * This is the main entry point for idempotent execution:
   * 1. Check if action was already executed
   * 2. If COMPLETED, return cached result
   * 3. If PROCESSING, wait and check again (another process is handling it)
   * 4. If new, execute and store result
   */
  async executeWithIdempotency<T>(
    nodeRunId: string,
    actionHash: string,
    executor: () => Promise<T>,
    options?: {
      waitForProcessingMs?: number;
      maxWaitAttempts?: number;
    },
  ): Promise<{ result: T; fromCache: boolean }> {
    const { waitForProcessingMs = 2000, maxWaitAttempts = 30 } = options || {};

    let attempts = 0;

    while (attempts < maxWaitAttempts) {
      const check = await this.checkAndAcquire(nodeRunId, actionHash);

      if (check.isNew) {
        // We have the lock - execute the action
        try {
          const result = await executor();
          await this.markCompleted(nodeRunId, actionHash, result);
          return { result, fromCache: false };
        } catch (error: any) {
          await this.markFailed(nodeRunId, actionHash, error.message);
          throw error;
        }
      }

      switch (check.status) {
        case IdempotencyStatus.COMPLETED:
          // Action already completed - return cached result
          this.logger.debug(`Returning cached result for ${nodeRunId}:${actionHash}`);
          return { result: check.result as T, fromCache: true };

        case IdempotencyStatus.FAILED:
          // Action failed previously - throw the stored error
          throw new Error(`Previous execution failed: ${check.errorMessage}`);

        case IdempotencyStatus.PROCESSING:
          // Another process is executing - wait and retry
          this.logger.debug(
            `Action ${nodeRunId}:${actionHash} is being processed by another instance, waiting...`,
          );
          await this.sleep(waitForProcessingMs);
          attempts++;
          break;
      }
    }

    throw new Error(
      `Timeout waiting for action ${nodeRunId}:${actionHash} to complete (${maxWaitAttempts} attempts)`,
    );
  }

  /**
   * Clean up expired idempotency records
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.prisma.idempotencyRecord.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} expired idempotency records`);
    }

    return result.count;
  }

  /**
   * Reset a PROCESSING record (for recovery from crashes)
   * Only use this if you know the processing instance has crashed
   */
  async resetStaleProcessing(
    nodeRunId: string,
    actionHash: string,
    staleDurationMs: number = 5 * 60 * 1000, // 5 minutes
  ): Promise<boolean> {
    const idempotencyKey = this.generateKey(nodeRunId, actionHash);

    const staleThreshold = new Date(Date.now() - staleDurationMs);

    const result = await this.prisma.idempotencyRecord.updateMany({
      where: {
        idempotencyKey,
        status: IdempotencyStatus.PROCESSING,
        createdAt: { lt: staleThreshold },
      },
      data: {
        status: IdempotencyStatus.FAILED,
        errorMessage: 'Reset due to stale processing state',
      },
    });

    if (result.count > 0) {
      this.logger.warn(`Reset stale processing record for ${idempotencyKey}`);
      return true;
    }

    return false;
  }

  /**
   * Get statistics about idempotency records
   */
  async getStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    expired: number;
  }> {
    const [total, processing, completed, failed, expired] = await Promise.all([
      this.prisma.idempotencyRecord.count(),
      this.prisma.idempotencyRecord.count({ where: { status: IdempotencyStatus.PROCESSING } }),
      this.prisma.idempotencyRecord.count({ where: { status: IdempotencyStatus.COMPLETED } }),
      this.prisma.idempotencyRecord.count({ where: { status: IdempotencyStatus.FAILED } }),
      this.prisma.idempotencyRecord.count({ where: { expiresAt: { lt: new Date() } } }),
    ]);

    return {
      total,
      byStatus: {
        [IdempotencyStatus.PROCESSING]: processing,
        [IdempotencyStatus.COMPLETED]: completed,
        [IdempotencyStatus.FAILED]: failed,
      },
      expired,
    };
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
