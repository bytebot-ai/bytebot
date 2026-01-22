/**
 * Action Logging Service
 * Phase 6.4: Agent Integration
 *
 * Logs agent actions to the Desktop Router for audit and retraining.
 * Actions are batched and sent asynchronously to avoid blocking task execution.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskControllerService } from '../task-controller/task-controller.service';

/**
 * Action log entry to be sent to the Desktop Router
 */
export interface ActionLogEntry {
  taskId: string;
  actionType: string;
  actionStatus: 'success' | 'failed' | 'skipped';
  coordinates?: { x: number; y: number };
  elementDescription?: string;
  maskedInput?: string;
  llmReasoning?: string;
  llmModel?: string;
  llmTokenCount?: number;
  durationMs?: number;
  errorMessage?: string;
  screenshotKey?: string;
  actionData?: Record<string, unknown>;
}

/**
 * Pending action with retry metadata
 */
interface PendingAction {
  entry: ActionLogEntry;
  attempts: number;
  lastAttempt: number;
}

@Injectable()
export class ActionLoggingService implements OnModuleDestroy {
  private readonly logger = new Logger(ActionLoggingService.name);
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly internalToken: string;
  private readonly pendingActions: Map<string, PendingAction[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly taskControllerService: TaskControllerService,
  ) {
    this.enabled = this.configService.get<string>('ACTION_LOGGING_ENABLED', 'true') === 'true';
    this.batchSize = parseInt(
      this.configService.get<string>('ACTION_LOG_BATCH_SIZE', '10'),
      10,
    );
    this.flushIntervalMs = parseInt(
      this.configService.get<string>('ACTION_LOG_FLUSH_INTERVAL_MS', '5000'),
      10,
    );
    this.maxRetries = parseInt(
      this.configService.get<string>('ACTION_LOG_MAX_RETRIES', '3'),
      10,
    );
    // Phase 3: Internal service token for router authentication
    this.internalToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN', '');

    if (this.enabled) {
      this.startFlushInterval();
      this.logger.log(
        `Action logging enabled: batch=${this.batchSize}, flush=${this.flushIntervalMs}ms`,
      );
    } else {
      this.logger.log('Action logging disabled');
    }
  }

  onModuleDestroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Flush remaining actions synchronously on shutdown
    for (const taskId of this.pendingActions.keys()) {
      this.flushActions(taskId).catch((error) => {
        this.logger.error(`Failed to flush actions for ${taskId} on shutdown: ${error.message}`);
      });
    }
  }

  /**
   * Log an action asynchronously
   * Actions are queued and sent in batches to avoid blocking
   */
  async logAction(entry: ActionLogEntry): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const { taskId } = entry;

    // Initialize queue for this task if needed
    if (!this.pendingActions.has(taskId)) {
      this.pendingActions.set(taskId, []);
    }

    const pending: PendingAction = {
      entry: {
        ...entry,
        // Mask sensitive input
        maskedInput: entry.maskedInput ? this.maskSensitiveInput(entry.maskedInput) : undefined,
      },
      attempts: 0,
      lastAttempt: 0,
    };

    this.pendingActions.get(taskId)!.push(pending);

    // If batch is full, flush immediately
    if (this.pendingActions.get(taskId)!.length >= this.batchSize) {
      this.flushActions(taskId).catch((error) => {
        this.logger.error(`Failed to flush actions for ${taskId}: ${error.message}`);
      });
    }
  }

  /**
   * Log action synchronously (blocks until sent)
   * Use sparingly - only for critical actions that must be logged
   */
  async logActionSync(entry: ActionLogEntry): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }

    try {
      const routerUrl = await this.taskControllerService.getRouterUrl(entry.taskId);
      if (!routerUrl) {
        this.logger.debug(`No router URL for ${entry.taskId}, skipping action log`);
        return false;
      }

      await this.sendActionToRouter(routerUrl, entry);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to log action sync: ${error.message}`);
      return false;
    }
  }

  /**
   * Flush all pending actions for a task
   */
  async flushActions(taskId: string): Promise<void> {
    const pending = this.pendingActions.get(taskId);
    if (!pending || pending.length === 0) {
      return;
    }

    const routerUrl = await this.taskControllerService.getRouterUrl(taskId);
    if (!routerUrl) {
      this.logger.debug(`No router URL for ${taskId}, clearing ${pending.length} pending actions`);
      this.pendingActions.set(taskId, []);
      return;
    }

    // Take all pending actions
    const toSend = [...pending];
    this.pendingActions.set(taskId, []);

    const failed: PendingAction[] = [];

    for (const action of toSend) {
      try {
        await this.sendActionToRouter(routerUrl, action.entry);
        this.logger.debug(`Logged action: ${action.entry.actionType} for ${taskId}`);
      } catch (error: any) {
        action.attempts++;
        action.lastAttempt = Date.now();

        if (action.attempts < this.maxRetries) {
          failed.push(action);
          this.logger.warn(
            `Action log failed (attempt ${action.attempts}/${this.maxRetries}): ${error.message}`,
          );
        } else {
          this.logger.error(
            `Action log permanently failed after ${this.maxRetries} attempts: ${error.message}`,
          );
        }
      }
    }

    // Re-queue failed actions for retry
    if (failed.length > 0) {
      const existing = this.pendingActions.get(taskId) || [];
      this.pendingActions.set(taskId, [...failed, ...existing]);
    }
  }

  /**
   * Flush all pending actions for all tasks
   */
  async flushAll(): Promise<void> {
    const taskIds = Array.from(this.pendingActions.keys());
    await Promise.all(taskIds.map((taskId) => this.flushActions(taskId)));
  }

  /**
   * Clear pending actions for a task (on task completion)
   */
  clearPending(taskId: string): void {
    const pending = this.pendingActions.get(taskId);
    if (pending && pending.length > 0) {
      this.logger.warn(`Clearing ${pending.length} pending actions for ${taskId}`);
    }
    this.pendingActions.delete(taskId);
  }

  /**
   * Get count of pending actions
   */
  getPendingCount(taskId?: string): number {
    if (taskId) {
      return this.pendingActions.get(taskId)?.length || 0;
    }
    let total = 0;
    for (const pending of this.pendingActions.values()) {
      total += pending.length;
    }
    return total;
  }

  /**
   * Send action to the Desktop Router
   * Phase 3: Added X-Internal-Token for service-to-service authentication
   */
  private async sendActionToRouter(routerUrl: string, entry: ActionLogEntry): Promise<void> {
    const url = `${routerUrl}/desktop/${entry.taskId}/action`;

    // Build headers with internal service token for authentication
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.internalToken) {
      headers['X-Internal-Token'] = this.internalToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        taskId: entry.taskId,
        actionType: entry.actionType,
        actionStatus: entry.actionStatus,
        coordinates: entry.coordinates,
        elementDescription: entry.elementDescription,
        maskedInput: entry.maskedInput,
        llmReasoning: entry.llmReasoning,
        llmModel: entry.llmModel,
        llmTokenCount: entry.llmTokenCount,
        durationMs: entry.durationMs,
        errorMessage: entry.errorMessage,
        screenshotKey: entry.screenshotKey,
        actionData: entry.actionData,
        timestamp: new Date().toISOString(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Router returned ${response.status}: ${response.statusText}`);
    }
  }

  /**
   * Start periodic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      this.flushAll().catch((error) => {
        this.logger.error(`Periodic flush failed: ${error.message}`);
      });
    }, this.flushIntervalMs);
  }

  /**
   * Mask sensitive input (passwords, tokens, etc.)
   */
  private maskSensitiveInput(input: string): string {
    // Simple masking - replace with asterisks but preserve length indication
    if (input.length <= 4) {
      return '****';
    }
    return `${input.substring(0, 2)}${'*'.repeat(Math.min(input.length - 4, 20))}${input.substring(input.length - 2)}`;
  }
}
