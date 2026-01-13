/**
 * Background Mode Service
 * v1.0.0: OpenAI-Style Background Mode for Long-Running Operations
 *
 * Implements industry-standard patterns for asynchronous task execution:
 * - OpenAI: Assistants API with async runs and polling
 * - Anthropic: Claude batch API pattern
 * - AWS: Step Functions async execution with callbacks
 *
 * Key Features:
 * 1. Async task submission with immediate response
 * 2. Progress polling and streaming updates
 * 3. Webhook callbacks on completion
 * 4. Timeout handling and graceful degradation
 * 5. Task queuing with priority support
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';

// Task states following OpenAI Assistants API pattern
export type BackgroundTaskStatus =
  | 'queued'      // Task waiting to start
  | 'in_progress' // Task actively running
  | 'completed'   // Task finished successfully
  | 'failed'      // Task failed with error
  | 'cancelled'   // Task was cancelled
  | 'expired';    // Task timed out

export interface BackgroundTask {
  id: string;
  goalRunId: string;
  type: 'goal_execution' | 'batch_processing' | 'analysis' | 'export';
  status: BackgroundTaskStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  progress: {
    current: number;
    total: number;
    message: string;
  };
  result?: {
    success: boolean;
    data?: any;
    error?: string;
  };
  metadata: {
    priority: 'low' | 'normal' | 'high';
    callbackUrl?: string;
    webhookSecret?: string;
    estimatedDurationMs?: number;
  };
}

export interface TaskSubmissionResult {
  taskId: string;
  status: BackgroundTaskStatus;
  estimatedCompletionTime?: Date;
  pollingUrl: string;
  webhookConfigured: boolean;
}

export interface TaskProgressUpdate {
  taskId: string;
  status: BackgroundTaskStatus;
  progress: {
    current: number;
    total: number;
    message: string;
    percentComplete: number;
  };
  estimatedTimeRemainingMs?: number;
  result?: any;
}

@Injectable()
export class BackgroundModeService {
  private readonly logger = new Logger(BackgroundModeService.name);
  private readonly enabled: boolean;

  // In-memory task storage (production would use Redis/database)
  private tasks: Map<string, BackgroundTask> = new Map();

  // Task queue by priority
  private taskQueue: {
    high: string[];
    normal: string[];
    low: string[];
  } = { high: [], normal: [], low: [] };

  // Configuration
  private readonly maxConcurrentTasks: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly progressPollIntervalMs: number;
  private readonly baseUrl: string;

  // Active task count
  private activeTaskCount: number = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.enabled = this.configService.get('BACKGROUND_MODE_ENABLED', 'true') === 'true';
    this.maxConcurrentTasks = parseInt(this.configService.get('MAX_CONCURRENT_BACKGROUND_TASKS', '10'), 10);
    this.defaultTimeoutMs = parseInt(this.configService.get('BACKGROUND_TASK_TIMEOUT_MS', '3600000'), 10); // 1 hour
    this.maxTimeoutMs = parseInt(this.configService.get('MAX_BACKGROUND_TASK_TIMEOUT_MS', '86400000'), 10); // 24 hours
    this.progressPollIntervalMs = parseInt(this.configService.get('PROGRESS_POLL_INTERVAL_MS', '5000'), 10);
    this.baseUrl = this.configService.get('API_BASE_URL', 'http://localhost:8080');

    this.logger.log(
      `Background mode ${this.enabled ? 'enabled' : 'disabled'} ` +
      `(max concurrent: ${this.maxConcurrentTasks}, timeout: ${this.defaultTimeoutMs}ms)`
    );

    // Start the task processor
    if (this.enabled) {
      this.startTaskProcessor();
      this.startExpirationChecker();
    }
  }

  /**
   * Submit a task for background execution
   */
  async submitTask(
    goalRunId: string,
    type: BackgroundTask['type'],
    options: {
      priority?: 'low' | 'normal' | 'high';
      timeoutMs?: number;
      callbackUrl?: string;
      webhookSecret?: string;
      estimatedDurationMs?: number;
    } = {},
  ): Promise<TaskSubmissionResult> {
    if (!this.enabled) {
      throw new Error('Background mode is disabled');
    }

    const taskId = this.generateTaskId();
    const now = new Date();
    const timeoutMs = Math.min(options.timeoutMs || this.defaultTimeoutMs, this.maxTimeoutMs);
    const priority = options.priority || 'normal';

    const task: BackgroundTask = {
      id: taskId,
      goalRunId,
      type,
      status: 'queued',
      createdAt: now,
      expiresAt: new Date(now.getTime() + timeoutMs),
      progress: {
        current: 0,
        total: 100,
        message: 'Task queued',
      },
      metadata: {
        priority,
        callbackUrl: options.callbackUrl,
        webhookSecret: options.webhookSecret,
        estimatedDurationMs: options.estimatedDurationMs,
      },
    };

    // Store task
    this.tasks.set(taskId, task);

    // Add to queue
    this.taskQueue[priority].push(taskId);

    this.logger.log(`Task ${taskId} submitted for goal ${goalRunId} (priority: ${priority})`);

    // Emit event
    this.eventEmitter.emit('background.task.submitted', {
      taskId,
      goalRunId,
      type,
      priority,
    });

    // Calculate estimated completion time
    const queuePosition = this.calculateQueuePosition(taskId);
    const estimatedWaitMs = queuePosition * (options.estimatedDurationMs || 60000);
    const estimatedCompletionTime = new Date(now.getTime() + estimatedWaitMs);

    return {
      taskId,
      status: 'queued',
      estimatedCompletionTime,
      pollingUrl: `${this.baseUrl}/api/v1/background-tasks/${taskId}`,
      webhookConfigured: !!options.callbackUrl,
    };
  }

  /**
   * Get task status and progress
   */
  getTaskStatus(taskId: string): TaskProgressUpdate | null {
    const task = this.tasks.get(taskId);
    if (!task) {
      return null;
    }

    const percentComplete = Math.round((task.progress.current / task.progress.total) * 100);

    // Estimate remaining time based on progress
    let estimatedTimeRemainingMs: number | undefined;
    if (task.status === 'in_progress' && task.startedAt && task.progress.current > 0) {
      const elapsedMs = Date.now() - task.startedAt.getTime();
      const progressPerMs = task.progress.current / elapsedMs;
      const remaining = task.progress.total - task.progress.current;
      estimatedTimeRemainingMs = Math.round(remaining / progressPerMs);
    }

    return {
      taskId,
      status: task.status,
      progress: {
        ...task.progress,
        percentComplete,
      },
      estimatedTimeRemainingMs,
      result: task.result,
    };
  }

  /**
   * Update task progress (called by executing service)
   */
  updateProgress(
    taskId: string,
    current: number,
    total: number,
    message: string,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger.warn(`Cannot update progress for unknown task ${taskId}`);
      return;
    }

    task.progress = { current, total, message };

    // Emit progress event for streaming updates
    this.eventEmitter.emit('background.task.progress', {
      taskId,
      goalRunId: task.goalRunId,
      current,
      total,
      message,
      percentComplete: Math.round((current / total) * 100),
    });
  }

  /**
   * Mark task as completed
   */
  async completeTask(taskId: string, result: any): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger.warn(`Cannot complete unknown task ${taskId}`);
      return;
    }

    task.status = 'completed';
    task.completedAt = new Date();
    task.result = { success: true, data: result };
    task.progress = {
      current: task.progress.total,
      total: task.progress.total,
      message: 'Task completed successfully',
    };

    this.activeTaskCount--;

    this.logger.log(`Task ${taskId} completed successfully`);

    // Emit completion event
    this.eventEmitter.emit('background.task.completed', {
      taskId,
      goalRunId: task.goalRunId,
      result,
    });

    // Send webhook callback if configured
    if (task.metadata.callbackUrl) {
      await this.sendWebhookCallback(task, 'completed');
    }
  }

  /**
   * Mark task as failed
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.logger.warn(`Cannot fail unknown task ${taskId}`);
      return;
    }

    task.status = 'failed';
    task.completedAt = new Date();
    task.result = { success: false, error };
    task.progress.message = `Failed: ${error}`;

    this.activeTaskCount--;

    this.logger.error(`Task ${taskId} failed: ${error}`);

    // Emit failure event
    this.eventEmitter.emit('background.task.failed', {
      taskId,
      goalRunId: task.goalRunId,
      error,
    });

    // Send webhook callback if configured
    if (task.metadata.callbackUrl) {
      await this.sendWebhookCallback(task, 'failed');
    }
  }

  /**
   * Cancel a queued or running task
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false; // Already terminal state
    }

    task.status = 'cancelled';
    task.completedAt = new Date();
    task.result = { success: false, error: 'Task cancelled by user' };

    // Remove from queue if queued
    if (task.metadata.priority) {
      const queue = this.taskQueue[task.metadata.priority];
      const index = queue.indexOf(taskId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }

    if (task.startedAt) {
      this.activeTaskCount--;
    }

    this.logger.log(`Task ${taskId} cancelled`);

    // Emit cancellation event
    this.eventEmitter.emit('background.task.cancelled', {
      taskId,
      goalRunId: task.goalRunId,
    });

    // Send webhook callback if configured
    if (task.metadata.callbackUrl) {
      await this.sendWebhookCallback(task, 'cancelled');
    }

    return true;
  }

  /**
   * Get all tasks for a goal
   */
  getTasksForGoal(goalRunId: string): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.goalRunId === goalRunId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): {
    queuedTasks: number;
    activeTasks: number;
    completedTasks: number;
    failedTasks: number;
    queueByPriority: { high: number; normal: number; low: number };
  } {
    const stats = {
      queuedTasks: 0,
      activeTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      queueByPriority: {
        high: this.taskQueue.high.length,
        normal: this.taskQueue.normal.length,
        low: this.taskQueue.low.length,
      },
    };

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case 'queued':
          stats.queuedTasks++;
          break;
        case 'in_progress':
          stats.activeTasks++;
          break;
        case 'completed':
          stats.completedTasks++;
          break;
        case 'failed':
        case 'expired':
        case 'cancelled':
          stats.failedTasks++;
          break;
      }
    }

    return stats;
  }

  /**
   * Start the task processor interval
   */
  private startTaskProcessor(): void {
    const callback = async () => {
      await this.processQueue();
    };

    const interval = setInterval(callback, 1000); // Check every second
    this.schedulerRegistry.addInterval('background-task-processor', interval);
    this.logger.debug('Background task processor started');
  }

  /**
   * Start the expiration checker interval
   */
  private startExpirationChecker(): void {
    const callback = async () => {
      await this.checkExpirations();
    };

    const interval = setInterval(callback, 30000); // Check every 30 seconds
    this.schedulerRegistry.addInterval('background-expiration-checker', interval);
    this.logger.debug('Background expiration checker started');
  }

  /**
   * Process task queue - start next task if capacity available
   */
  private async processQueue(): Promise<void> {
    if (this.activeTaskCount >= this.maxConcurrentTasks) {
      return; // At capacity
    }

    // Get next task from queue (priority order: high > normal > low)
    let nextTaskId: string | undefined;

    if (this.taskQueue.high.length > 0) {
      nextTaskId = this.taskQueue.high.shift();
    } else if (this.taskQueue.normal.length > 0) {
      nextTaskId = this.taskQueue.normal.shift();
    } else if (this.taskQueue.low.length > 0) {
      nextTaskId = this.taskQueue.low.shift();
    }

    if (!nextTaskId) {
      return; // No tasks in queue
    }

    const task = this.tasks.get(nextTaskId);
    if (!task || task.status !== 'queued') {
      return;
    }

    // Start the task
    task.status = 'in_progress';
    task.startedAt = new Date();
    task.progress.message = 'Task started';
    this.activeTaskCount++;

    this.logger.log(`Starting background task ${nextTaskId}`);

    // Emit start event - the actual execution is handled by event listeners
    this.eventEmitter.emit('background.task.started', {
      taskId: nextTaskId,
      goalRunId: task.goalRunId,
      type: task.type,
    });
  }

  /**
   * Check for expired tasks
   */
  private async checkExpirations(): Promise<void> {
    const now = new Date();

    for (const task of this.tasks.values()) {
      if (
        (task.status === 'queued' || task.status === 'in_progress') &&
        task.expiresAt < now
      ) {
        // Decrement active count before changing status
        const wasInProgress = task.status === 'in_progress';

        task.status = 'expired';
        task.completedAt = now;
        task.result = { success: false, error: 'Task exceeded timeout' };

        if (wasInProgress) {
          this.activeTaskCount--;
        }

        this.logger.warn(`Task ${task.id} expired`);

        // Emit expiration event
        this.eventEmitter.emit('background.task.expired', {
          taskId: task.id,
          goalRunId: task.goalRunId,
        });

        // Send webhook callback if configured
        if (task.metadata.callbackUrl) {
          await this.sendWebhookCallback(task, 'expired');
        }
      }
    }

    // Clean up old completed tasks (older than 1 hour)
    const cleanupThreshold = new Date(now.getTime() - 3600000);
    for (const [taskId, task] of this.tasks.entries()) {
      if (
        task.completedAt &&
        task.completedAt < cleanupThreshold &&
        ['completed', 'failed', 'cancelled', 'expired'].includes(task.status)
      ) {
        this.tasks.delete(taskId);
        this.logger.debug(`Cleaned up old task ${taskId}`);
      }
    }
  }

  /**
   * Send webhook callback
   */
  private async sendWebhookCallback(
    task: BackgroundTask,
    event: 'completed' | 'failed' | 'cancelled' | 'expired',
  ): Promise<void> {
    if (!task.metadata.callbackUrl) {
      return;
    }

    try {
      const payload = {
        event: `task.${event}`,
        taskId: task.id,
        goalRunId: task.goalRunId,
        status: task.status,
        result: task.result,
        timestamp: new Date().toISOString(),
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add HMAC signature if secret configured
      if (task.metadata.webhookSecret) {
        const crypto = require('crypto');
        const signature = crypto
          .createHmac('sha256', task.metadata.webhookSecret)
          .update(JSON.stringify(payload))
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      await fetch(task.metadata.callbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      this.logger.debug(`Webhook callback sent for task ${task.id}`);
    } catch (error) {
      this.logger.warn(`Webhook callback failed for task ${task.id}: ${(error as Error).message}`);
    }
  }

  /**
   * Generate unique task ID
   */
  private generateTaskId(): string {
    return `bg-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * Calculate queue position for a task
   */
  private calculateQueuePosition(taskId: string): number {
    let position = 0;

    // Count all higher priority tasks ahead
    position += this.taskQueue.high.indexOf(taskId) === -1
      ? this.taskQueue.high.length
      : this.taskQueue.high.indexOf(taskId);

    const normalIndex = this.taskQueue.normal.indexOf(taskId);
    if (normalIndex !== -1) {
      position += normalIndex;
    } else {
      position += this.taskQueue.normal.length;
    }

    const lowIndex = this.taskQueue.low.indexOf(taskId);
    if (lowIndex !== -1) {
      position += lowIndex;
    }

    // Add currently active tasks
    position += this.activeTaskCount;

    return position;
  }
}
