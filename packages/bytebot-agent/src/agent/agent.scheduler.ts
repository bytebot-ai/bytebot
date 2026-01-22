import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { TasksService } from '../tasks/tasks.service';
import { AgentProcessor } from './agent.processor';
import { TaskStatus } from '@prisma/client';
import { writeFile } from './agent.computer-use';

/**
 * v2.2.5: Interval for lease renewal (in milliseconds)
 * Should be less than the lease timeout to prevent expiration during processing
 * Default: 60 seconds (lease timeout is 300 seconds)
 */
const LEASE_RENEWAL_INTERVAL_MS = 60000;

@Injectable()
export class AgentScheduler implements OnModuleInit {
  private readonly logger = new Logger(AgentScheduler.name);

  constructor(
    private readonly tasksService: TasksService,
    private readonly agentProcessor: AgentProcessor,
  ) {}

  async onModuleInit() {
    this.logger.log('AgentScheduler initialized');
    await this.handleCron();
  }

  @Cron(CronExpression.EVERY_5_SECONDS)
  async handleCron() {
    const now = new Date();
    const scheduledTasks = await this.tasksService.findScheduledTasks();
    for (const scheduledTask of scheduledTasks) {
      if (scheduledTask.scheduledFor && scheduledTask.scheduledFor < now) {
        this.logger.debug(
          `Task ID: ${scheduledTask.id} is scheduled for ${scheduledTask.scheduledFor}, queuing it`,
        );
        await this.tasksService.update(scheduledTask.id, {
          queuedAt: now,
        });
      }
    }

    if (this.agentProcessor.isRunning()) {
      return;
    }

    // v2.2.3: Use atomic task claiming to prevent race conditions
    // This replaces the previous findNextTask() + update() pattern which allowed
    // multiple pods to claim the same task simultaneously
    const task = await this.tasksService.claimNextTask();

    if (task) {
      // Write any attached files to the desktop
      if (task.files.length > 0) {
        this.logger.debug(
          `Task ID: ${task.id} has files, writing them to the desktop`,
        );
        for (const file of task.files) {
          await writeFile({
            path: `/home/user/Desktop/${file.name}`,
            content: file.data, // file.data is already base64 encoded in the database
          });
        }
      }

      // Task is already marked as RUNNING by claimNextTask()
      this.logger.debug(`Processing claimed task ID: ${task.id}`);
      this.agentProcessor.processTask(task.id);
    }
  }

  /**
   * v2.2.5: Periodically renew the lease for the currently processing task.
   * This prevents the task from being marked as orphaned while it's still being worked on.
   * Runs every 60 seconds (less than the 5-minute lease timeout).
   */
  @Interval(LEASE_RENEWAL_INTERVAL_MS)
  async renewCurrentTaskLease() {
    const currentTaskId = this.agentProcessor.getCurrentTaskId();
    const podName = process.env.POD_NAME || 'unknown';

    if (!currentTaskId || !this.agentProcessor.isRunning()) {
      return;
    }

    this.logger.debug(`Renewing lease for current task ${currentTaskId}`);
    const renewed = await this.tasksService.renewLease(currentTaskId, podName);

    if (!renewed) {
      this.logger.warn(
        `Failed to renew lease for task ${currentTaskId} - may have been claimed by another pod`,
      );
      // Note: The processor will detect this on next iteration when task status changes
    }
  }

  /**
   * v2.2.5: Recover orphaned tasks with expired leases.
   * Runs every minute to check for tasks that were abandoned by crashed workers.
   *
   * Note: This is intentionally on a slower schedule than task claiming to reduce
   * database load. Orphaned tasks are not time-critical since they've already failed.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async recoverOrphanedTasks() {
    const recoveredIds = await this.tasksService.recoverOrphanedTasks();

    if (recoveredIds.length > 0) {
      this.logger.warn(
        `Recovered ${recoveredIds.length} orphaned task(s): ${recoveredIds.join(', ')}`,
      );
    }
  }
}
