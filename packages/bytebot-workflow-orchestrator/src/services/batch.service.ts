/**
 * Batch Service
 * Phase 7: Enhanced Features
 *
 * Responsibilities:
 * - Create and manage batch goal runs
 * - Execute multiple goals in parallel or sequence
 * - Track batch progress and completion
 * - Handle batch-level error policies (stop on failure, etc.)
 * - Rate limit batch execution to respect system limits
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { GoalRunService, GoalConstraints, GoalRunStatus } from './goal-run.service';
import { GoalTemplateService } from './goal-template.service';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';

// Input types
export interface CreateBatchInput {
  tenantId: string;
  name: string;
  description?: string;
  executionMode?: 'PARALLEL' | 'SEQUENTIAL';
  maxConcurrency?: number;
  stopOnFailure?: boolean;
  goals: BatchGoalInput[];
}

export interface BatchGoalInput {
  goal: string;
  constraints?: GoalConstraints;
  templateId?: string;
  variableValues?: Record<string, string | number | boolean>;
}

export interface BatchFilters {
  status?: string;
  page?: number;
  pageSize?: number;
}

// Status constants
export type BatchStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type BatchItemStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'SKIPPED';

// Response types
export interface BatchResponse {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  executionMode: string;
  maxConcurrency: number;
  stopOnFailure: boolean;
  status: BatchStatus;
  totalGoals: number;
  completedGoals: number;
  failedGoals: number;
  cancelledGoals: number;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  progress: number; // 0-100
}

export interface BatchItemResponse {
  id: string;
  batchId: string;
  goal: string;
  constraints: GoalConstraints;
  templateId?: string | null;
  variableValues: Record<string, any>;
  order: number;
  status: BatchItemStatus;
  goalRunId?: string | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface BatchWithItemsResponse extends BatchResponse {
  items: BatchItemResponse[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);
  private runningBatches: Map<string, boolean> = new Map(); // Track running batch loops

  constructor(
    private prisma: PrismaService,
    private goalRunService: GoalRunService,
    private goalTemplateService: GoalTemplateService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new batch
   */
  async create(input: CreateBatchInput): Promise<BatchWithItemsResponse> {
    const batchId = `batch-${createId()}`;

    this.logger.log(`Creating batch ${batchId}: "${input.name}" with ${input.goals.length} goals`);

    if (!input.goals || input.goals.length === 0) {
      throw new BadRequestException('Batch must contain at least one goal');
    }

    if (input.goals.length > 100) {
      throw new BadRequestException('Batch cannot contain more than 100 goals');
    }

    // Create batch with items in a transaction
    const batch = await this.prisma.$transaction(async (tx) => {
      // Create batch
      const newBatch = await tx.goalRunBatch.create({
        data: {
          id: batchId,
          tenantId: input.tenantId,
          name: input.name,
          description: input.description,
          executionMode: input.executionMode || 'PARALLEL',
          maxConcurrency: input.maxConcurrency || 5,
          stopOnFailure: input.stopOnFailure || false,
          status: 'PENDING',
          totalGoals: input.goals.length,
        },
      });

      // Create batch items
      const itemsData = input.goals.map((goal, index) => ({
        id: `bi-${createId()}`,
        batchId,
        goal: goal.goal,
        constraints: (goal.constraints || {}) as object,
        templateId: goal.templateId,
        variableValues: (goal.variableValues || {}) as object,
        order: index + 1,
        status: 'PENDING',
      }));

      await tx.goalRunBatchItem.createMany({
        data: itemsData,
      });

      return newBatch;
    });

    // Fetch items
    const items = await this.prisma.goalRunBatchItem.findMany({
      where: { batchId },
      orderBy: { order: 'asc' },
    });

    this.eventEmitter.emit('batch.created', {
      batchId,
      tenantId: input.tenantId,
      goalCount: input.goals.length,
    });

    return {
      ...this.toBatchResponse(batch),
      items: items.map(this.toItemResponse),
    };
  }

  /**
   * Get batch by ID
   */
  async findById(batchId: string): Promise<BatchResponse> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    return this.toBatchResponse(batch);
  }

  /**
   * Get batch with items
   */
  async findByIdWithItems(batchId: string): Promise<BatchWithItemsResponse> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
      include: {
        items: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    return {
      ...this.toBatchResponse(batch),
      items: batch.items.map(this.toItemResponse),
    };
  }

  /**
   * List batches for a tenant
   */
  async findByTenant(
    tenantId: string,
    filters?: BatchFilters,
  ): Promise<PaginatedResponse<BatchResponse>> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.GoalRunBatchWhereInput = {
      tenantId,
      ...(filters?.status && { status: filters.status }),
    };

    const [batches, total] = await Promise.all([
      this.prisma.goalRunBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.goalRunBatch.count({ where }),
    ]);

    return {
      data: batches.map(this.toBatchResponse),
      total,
      page,
      pageSize,
      hasMore: skip + batches.length < total,
    };
  }

  /**
   * Start batch execution
   */
  async start(batchId: string): Promise<BatchResponse> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    if (batch.status !== 'PENDING') {
      throw new BadRequestException(`Batch is already ${batch.status.toLowerCase()}`);
    }

    this.logger.log(`Starting batch ${batchId}`);

    const updatedBatch = await this.prisma.goalRunBatch.update({
      where: { id: batchId },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    // Mark all items as queued
    await this.prisma.goalRunBatchItem.updateMany({
      where: { batchId },
      data: { status: 'QUEUED' },
    });

    // Start the execution loop
    this.executeBatch(batchId);

    this.eventEmitter.emit('batch.started', { batchId });

    return this.toBatchResponse(updatedBatch);
  }

  /**
   * Cancel batch execution
   */
  async cancel(batchId: string, reason?: string): Promise<BatchResponse> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
      include: { items: true },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      throw new BadRequestException(`Batch is already ${batch.status.toLowerCase()}`);
    }

    this.logger.log(`Cancelling batch ${batchId}: ${reason}`);

    // Stop the execution loop
    this.runningBatches.set(batchId, false);

    // Cancel running goal runs
    for (const item of batch.items) {
      if (item.goalRunId && item.status === 'RUNNING') {
        try {
          await this.goalRunService.cancelGoalRun(item.goalRunId, 'Batch cancelled');
        } catch (error: any) {
          this.logger.warn(`Failed to cancel goal run ${item.goalRunId}: ${error.message}`);
        }
      }
    }

    // Update pending/queued items to cancelled
    await this.prisma.goalRunBatchItem.updateMany({
      where: {
        batchId,
        status: { in: ['PENDING', 'QUEUED', 'RUNNING'] },
      },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    // Update batch
    const cancelledCount = batch.items.filter(
      (i) => i.status === 'PENDING' || i.status === 'QUEUED' || i.status === 'RUNNING',
    ).length;

    const updatedBatch = await this.prisma.goalRunBatch.update({
      where: { id: batchId },
      data: {
        status: 'CANCELLED',
        error: reason || 'Cancelled by user',
        cancelledGoals: { increment: cancelledCount },
        completedAt: new Date(),
      },
    });

    this.eventEmitter.emit('batch.cancelled', { batchId, reason });

    return this.toBatchResponse(updatedBatch);
  }

  /**
   * Get batch item details
   */
  async getItem(batchId: string, itemId: string): Promise<BatchItemResponse> {
    const item = await this.prisma.goalRunBatchItem.findFirst({
      where: { id: itemId, batchId },
    });

    if (!item) {
      throw new NotFoundException(`Batch item ${itemId} not found`);
    }

    return this.toItemResponse(item);
  }

  /**
   * Retry failed items in a batch
   */
  async retryFailed(batchId: string): Promise<BatchResponse> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} not found`);
    }

    if (batch.status !== 'PARTIALLY_COMPLETED' && batch.status !== 'FAILED') {
      throw new BadRequestException('Can only retry failed or partially completed batches');
    }

    this.logger.log(`Retrying failed items in batch ${batchId}`);

    // Reset failed items
    const result = await this.prisma.goalRunBatchItem.updateMany({
      where: {
        batchId,
        status: 'FAILED',
      },
      data: {
        status: 'QUEUED',
        error: null,
        goalRunId: null,
        startedAt: null,
        completedAt: null,
      },
    });

    // Update batch status
    const updatedBatch = await this.prisma.goalRunBatch.update({
      where: { id: batchId },
      data: {
        status: 'RUNNING',
        failedGoals: { decrement: result.count },
        error: null,
        completedAt: null,
      },
    });

    // Restart execution
    this.executeBatch(batchId);

    this.eventEmitter.emit('batch.retrying', { batchId, itemCount: result.count });

    return this.toBatchResponse(updatedBatch);
  }

  /**
   * Execute batch (internal loop)
   */
  private async executeBatch(batchId: string): Promise<void> {
    this.runningBatches.set(batchId, true);

    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) {
      this.runningBatches.delete(batchId);
      return;
    }

    const isParallel = batch.executionMode === 'PARALLEL';
    const maxConcurrency = isParallel ? batch.maxConcurrency : 1;

    try {
      while (this.runningBatches.get(batchId)) {
        // Get queued items
        const queuedItems = await this.prisma.goalRunBatchItem.findMany({
          where: {
            batchId,
            status: 'QUEUED',
          },
          orderBy: { order: 'asc' },
          take: maxConcurrency,
        });

        if (queuedItems.length === 0) {
          // Check if there are still running items
          const runningCount = await this.prisma.goalRunBatchItem.count({
            where: { batchId, status: 'RUNNING' },
          });

          if (runningCount === 0) {
            // Batch is complete
            await this.completeBatch(batchId);
            break;
          }

          // Wait for running items to complete
          await this.sleep(1000);
          continue;
        }

        // Get currently running count
        const currentRunning = await this.prisma.goalRunBatchItem.count({
          where: { batchId, status: 'RUNNING' },
        });

        const canStart = Math.min(
          queuedItems.length,
          maxConcurrency - currentRunning,
        );

        if (canStart <= 0) {
          // At max concurrency, wait
          await this.sleep(1000);
          continue;
        }

        // Start items
        const itemsToStart = queuedItems.slice(0, canStart);

        if (isParallel) {
          // Start all in parallel
          await Promise.all(
            itemsToStart.map((item) => this.executeItem(batchId, item)),
          );
        } else {
          // Start one at a time (sequential)
          for (const item of itemsToStart) {
            if (!this.runningBatches.get(batchId)) break;
            await this.executeItem(batchId, item);
            await this.waitForItemCompletion(item.id);
          }
        }

        // Rate limit: wait between batches
        await this.sleep(500);
      }
    } catch (error: any) {
      this.logger.error(`Batch ${batchId} execution error: ${error.message}`);
      await this.prisma.goalRunBatch.update({
        where: { id: batchId },
        data: {
          status: 'FAILED',
          error: error.message,
          completedAt: new Date(),
        },
      });
    } finally {
      this.runningBatches.delete(batchId);
    }
  }

  /**
   * Execute a single batch item
   */
  private async executeItem(batchId: string, item: any): Promise<void> {
    this.logger.log(`Executing batch item ${item.id}`);

    try {
      // Update item status
      await this.prisma.goalRunBatchItem.update({
        where: { id: item.id },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
        },
      });

      // Get batch for tenant ID
      const batch = await this.prisma.goalRunBatch.findUnique({
        where: { id: batchId },
      });

      if (!batch) return;

      // Create goal run
      let goalRun;

      if (item.templateId) {
        // Create from template
        goalRun = await this.goalTemplateService.createGoalRunFromTemplate({
          tenantId: batch.tenantId,
          templateId: item.templateId,
          variableValues: item.variableValues as Record<string, string | number | boolean>,
          constraintOverrides: item.constraints as any,
          autoStart: true,
        });
      } else {
        // Create directly
        goalRun = await this.goalRunService.createFromGoal({
          tenantId: batch.tenantId,
          goal: item.goal,
          constraints: item.constraints as any,
          autoStart: true,
        });
      }

      // Link goal run to item
      await this.prisma.goalRunBatchItem.update({
        where: { id: item.id },
        data: { goalRunId: goalRun.id },
      });
    } catch (error: any) {
      this.logger.error(`Batch item ${item.id} failed to start: ${error.message}`);
      await this.handleItemFailure(batchId, item.id, error.message);
    }
  }

  /**
   * Wait for item completion
   */
  private async waitForItemCompletion(itemId: string): Promise<void> {
    const maxWaitMs = 30 * 60 * 1000; // 30 minutes max
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const item = await this.prisma.goalRunBatchItem.findUnique({
        where: { id: itemId },
      });

      if (!item || item.status !== 'RUNNING') {
        return;
      }

      await this.sleep(2000);
    }

    // Timeout - mark as failed
    await this.prisma.goalRunBatchItem.update({
      where: { id: itemId },
      data: {
        status: 'FAILED',
        error: 'Execution timeout',
        completedAt: new Date(),
      },
    });
  }

  /**
   * Handle item failure
   */
  private async handleItemFailure(
    batchId: string,
    itemId: string,
    error: string,
  ): Promise<void> {
    await this.prisma.goalRunBatchItem.update({
      where: { id: itemId },
      data: {
        status: 'FAILED',
        error,
        completedAt: new Date(),
      },
    });

    // Update batch counters
    await this.prisma.goalRunBatch.update({
      where: { id: batchId },
      data: { failedGoals: { increment: 1 } },
    });

    // Check if should stop on failure
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (batch?.stopOnFailure) {
      this.logger.log(`Batch ${batchId} stopping due to failure`);
      await this.cancel(batchId, 'Stopped due to item failure');
    }

    this.eventEmitter.emit('batch.item-failed', { batchId, itemId, error });
  }

  /**
   * Complete the batch
   */
  private async completeBatch(batchId: string): Promise<void> {
    const batch = await this.prisma.goalRunBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch) return;

    let status: BatchStatus;
    if (batch.failedGoals === 0 && batch.cancelledGoals === 0) {
      status = 'COMPLETED';
    } else if (batch.completedGoals > 0) {
      status = 'PARTIALLY_COMPLETED';
    } else {
      status = 'FAILED';
    }

    await this.prisma.goalRunBatch.update({
      where: { id: batchId },
      data: {
        status,
        completedAt: new Date(),
      },
    });

    this.eventEmitter.emit('batch.completed', { batchId, status });
  }

  /**
   * Handle goal run completion events
   */
  @OnEvent('goal-run.completed')
  async handleGoalRunCompleted(payload: { goalRunId: string }): Promise<void> {
    const item = await this.prisma.goalRunBatchItem.findFirst({
      where: { goalRunId: payload.goalRunId },
    });

    if (!item) return;

    await this.prisma.goalRunBatchItem.update({
      where: { id: item.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await this.prisma.goalRunBatch.update({
      where: { id: item.batchId },
      data: { completedGoals: { increment: 1 } },
    });
  }

  /**
   * Handle goal run failure events
   */
  @OnEvent('goal-run.failed')
  async handleGoalRunFailed(payload: { goalRunId: string; error: string }): Promise<void> {
    const item = await this.prisma.goalRunBatchItem.findFirst({
      where: { goalRunId: payload.goalRunId },
    });

    if (!item) return;

    await this.handleItemFailure(item.batchId, item.id, payload.error);
  }

  /**
   * Handle goal run cancellation events
   */
  @OnEvent('goal-run.cancelled')
  async handleGoalRunCancelled(payload: { goalRunId: string }): Promise<void> {
    const item = await this.prisma.goalRunBatchItem.findFirst({
      where: { goalRunId: payload.goalRunId },
    });

    if (!item) return;

    await this.prisma.goalRunBatchItem.update({
      where: { id: item.id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    await this.prisma.goalRunBatch.update({
      where: { id: item.batchId },
      data: { cancelledGoals: { increment: 1 } },
    });
  }

  // Helper methods

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toBatchResponse(batch: any): BatchResponse {
    const total = batch.totalGoals || 0;
    const completed = batch.completedGoals + batch.failedGoals + batch.cancelledGoals;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

    return {
      id: batch.id,
      tenantId: batch.tenantId,
      name: batch.name,
      description: batch.description,
      executionMode: batch.executionMode,
      maxConcurrency: batch.maxConcurrency,
      stopOnFailure: batch.stopOnFailure,
      status: batch.status as BatchStatus,
      totalGoals: batch.totalGoals,
      completedGoals: batch.completedGoals,
      failedGoals: batch.failedGoals,
      cancelledGoals: batch.cancelledGoals,
      error: batch.error,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      progress,
    };
  }

  private toItemResponse(item: any): BatchItemResponse {
    return {
      id: item.id,
      batchId: item.batchId,
      goal: item.goal,
      constraints: item.constraints as GoalConstraints,
      templateId: item.templateId,
      variableValues: item.variableValues as Record<string, any>,
      order: item.order,
      status: item.status as BatchItemStatus,
      goalRunId: item.goalRunId,
      error: item.error,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
    };
  }
}
