import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';

@Injectable()
export class AgentAnalyticsService {
  private readonly logger = new Logger(AgentAnalyticsService.name);
  private readonly endpoint?: string;

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    configService: ConfigService,
  ) {
    this.endpoint = configService.get<string>('BYTEBOT_ANALYTICS_ENDPOINT');
    if (!this.endpoint) {
      this.logger.warn(
        'BYTEBOT_ANALYTICS_ENDPOINT is not set. Analytics service disabled.',
      );
    }
  }

  @OnEvent('task.cancel')
  @OnEvent('task.failed')
  @OnEvent('task.completed')
  async handleTaskEvent(payload: { taskId: string }) {
    if (!this.endpoint) return;

    try {
      const task = await this.tasksService.findById(payload.taskId);
      const messages = await this.messagesService.findEvery(payload.taskId);

      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...task, messages }),
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to send analytics for task ${payload.taskId}: ${error.message}`,
        error.stack,
      );
    }
  }
}
