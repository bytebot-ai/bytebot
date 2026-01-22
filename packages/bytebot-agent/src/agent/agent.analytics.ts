import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { TaskControllerService } from '../task-controller/task-controller.service';

/**
 * Structured task event log format for metering service.
 *
 * v2.2.2: Added structured JSON logging for Loki/Fluent-bit collection.
 * The metering service queries Loki with:
 *   {job="fluent-bit"} |= "task_completed" | json
 *
 * Required fields:
 * - event: "task_completed" (required for LogQL filter)
 * - customer_id: Keycloak user ID for billing
 * - user_id: Same as customer_id
 * - task_id: Task UUID
 * - task_type: IMMEDIATE | SCHEDULED
 * - duration_ms: Task execution duration
 * - status: COMPLETED | FAILED | CANCELLED
 */
interface TaskMeteringEvent {
  event: 'task_completed';
  task_id: string;
  customer_id: string;
  user_id: string;
  task_type: string;
  duration_ms: number;
  status: string;
  timestamp: string;
}

@Injectable()
export class AgentAnalyticsService {
  private readonly logger = new Logger(AgentAnalyticsService.name);
  private readonly endpoint?: string;
  private readonly customerId: string;
  private readonly meteringEnabled: boolean;

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly taskControllerService: TaskControllerService,
    configService: ConfigService,
  ) {
    this.endpoint = configService.get<string>('BYTEBOT_ANALYTICS_ENDPOINT');
    if (!this.endpoint) {
      this.logger.warn(
        'BYTEBOT_ANALYTICS_ENDPOINT is not set. Analytics service disabled.',
      );
    }

    // v2.2.2: Get customer ID for metering from environment or fallback
    // In multi-tenant deployment, this is set per-user namespace
    this.customerId = configService.get<string>('BYTEBOT_CUSTOMER_ID')
      || configService.get<string>('BYTEBOT_TENANT_ID')
      || 'unknown';

    // Enable metering logs by default (can be disabled via env var)
    this.meteringEnabled = configService.get<string>('BYTEBOT_METERING_ENABLED', 'true') === 'true';

    if (this.meteringEnabled) {
      this.logger.log(`Metering enabled for customer: ${this.customerId}`);
    }
  }

  /**
   * v2.2.2: Emit structured JSON log for metering service collection.
   *
   * This outputs a JSON line to stdout that Fluent-bit collects and sends to Loki.
   * The metering service then queries Loki to aggregate task counts per customer.
   */
  private emitMeteringLog(event: TaskMeteringEvent): void {
    // Output structured JSON to stdout for Fluent-bit collection
    // Using console.log ensures it goes to stdout with newline
    console.log(JSON.stringify(event));
  }

  /**
   * Get customer ID for a task.
   *
   * Priority:
   * 1. TaskController tenantId (if Phase 6 enabled)
   * 2. Environment variable BYTEBOT_CUSTOMER_ID
   * 3. Fallback to 'unknown'
   */
  private async getCustomerId(taskId: string): Promise<string> {
    try {
      // Try to get tenant ID from task controller (Phase 6)
      if (this.taskControllerService.isPhase6Enabled()) {
        const taskInfo = await this.taskControllerService.getTaskInfo(taskId);
        if (taskInfo?.tenantId && taskInfo.tenantId !== 'default') {
          return taskInfo.tenantId;
        }
      }
    } catch (error) {
      // Ignore errors, fall back to environment-based customer ID
    }

    return this.customerId;
  }

  /**
   * Calculate task duration in milliseconds.
   */
  private calculateDurationMs(executedAt: Date | null, completedAt: Date | null): number {
    if (!executedAt || !completedAt) {
      return 0;
    }
    return completedAt.getTime() - executedAt.getTime();
  }

  @OnEvent('task.cancel')
  @OnEvent('task.failed')
  @OnEvent('task.completed')
  async handleTaskEvent(payload: { taskId: string }) {
    try {
      const task = await this.tasksService.findById(payload.taskId);

      // v2.2.2: Emit structured metering log
      if (this.meteringEnabled) {
        const customerId = await this.getCustomerId(payload.taskId);
        const durationMs = this.calculateDurationMs(
          task.executedAt,
          task.completedAt || new Date()
        );

        const meteringEvent: TaskMeteringEvent = {
          event: 'task_completed',
          task_id: task.id,
          customer_id: customerId,
          user_id: customerId, // Same as customer_id in this system
          task_type: task.type,
          duration_ms: durationMs,
          status: task.status,
          timestamp: new Date().toISOString(),
        };

        this.emitMeteringLog(meteringEvent);
        this.logger.debug(
          `Emitted metering event for task ${task.id}: customer=${customerId}, status=${task.status}, duration=${durationMs}ms`
        );
      }

      // Original analytics endpoint functionality
      if (this.endpoint) {
        const messages = await this.messagesService.findEvery(payload.taskId);
        await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...task, messages }),
        });
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to process task event for ${payload.taskId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
