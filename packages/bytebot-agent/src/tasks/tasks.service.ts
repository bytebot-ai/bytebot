import {
  Injectable,
  NotFoundException,
  Logger,
  BadRequestException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import {
  Task,
  Role,
  Prisma,
  TaskStatus,
  TaskType,
  TaskPriority,
  File,
  ExecutionSurface,
} from '@prisma/client';
import { AddTaskMessageDto } from './dto/add-task-message.dto';
import { TasksGateway } from './tasks.gateway';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TaskControllerService } from '../task-controller/task-controller.service';
import { TitleGenerationService } from './title-generation.service';

/**
 * v2.0.28: Maximum retry attempts for optimistic locking conflicts
 */
const MAX_UPDATE_RETRIES = 3;

/**
 * v2.2.5: Lease timeout for orphaned task recovery (in seconds)
 * Tasks running longer than this without renewal are considered orphaned
 * Default: 5 minutes = 300 seconds
 */
const TASK_LEASE_TIMEOUT_SECONDS = 300;

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    readonly prisma: PrismaService,
    @Inject(forwardRef(() => TasksGateway))
    private readonly tasksGateway: TasksGateway,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly taskControllerService: TaskControllerService,
    private readonly titleGenerationService: TitleGenerationService,
  ) {
    this.logger.log('TasksService initialized');
  }

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    this.logger.log(
      `Creating new task with description: ${createTaskDto.description}`,
    );

    // PR5: Keep execution surface + requiresDesktop consistent.
    // If a surface is explicitly provided, it wins; otherwise fall back to requiresDesktop.
    const requestedSurface = createTaskDto.executionSurface;
    const requiresDesktop =
      requestedSurface === ExecutionSurface.DESKTOP
        ? true
        : requestedSurface === ExecutionSurface.TEXT_ONLY
          ? false
          : createTaskDto.requiresDesktop || false;

    const task = await this.prisma.$transaction(async (prisma) => {
      // Create the task first
      this.logger.debug('Creating task record in database');
      const task = await prisma.task.create({
        data: {
          description: createTaskDto.description,
          // v2.2.16: Include title if provided, otherwise will be generated async
          title: createTaskDto.title || null,
          type: createTaskDto.type || TaskType.IMMEDIATE,
          priority: createTaskDto.priority || TaskPriority.MEDIUM,
          status: TaskStatus.PENDING,
          createdBy: createTaskDto.createdBy || Role.USER,
          model: createTaskDto.model,
          ...(createTaskDto.scheduledFor
            ? { scheduledFor: createTaskDto.scheduledFor }
            : {}),
          // v2.3.0 M4: Workflow context (null for Product 1 Tasks)
          workspaceId: createTaskDto.workspaceId || null,
          nodeRunId: createTaskDto.nodeRunId || null,
          // v2.3.0 M4: Tool configuration from workflow node definition
          allowedTools: createTaskDto.allowedTools || [],
          gatewayToolsOnly: createTaskDto.gatewayToolsOnly || false,
          highRiskTools: createTaskDto.highRiskTools || [],
          // Phase 4: Execution surface constraint
          requiresDesktop,
          // PR5: Explicit execution surface (nullable for backwards compatibility)
          executionSurface: requestedSurface || null,
        },
      });
      this.logger.log(
        `Task created successfully with ID: ${task.id}` +
          (task.workspaceId ? ` (workspace: ${task.workspaceId})` : '') +
          (task.requiresDesktop ? ' [desktop required]' : '') +
          (task.executionSurface ? ` [surface: ${task.executionSurface}]` : ''),
      );

      let filesDescription = '';

      // Save files if provided
      if (createTaskDto.files && createTaskDto.files.length > 0) {
        this.logger.debug(
          `Saving ${createTaskDto.files.length} file(s) for task ID: ${task.id}`,
        );
        filesDescription += `\n`;

        const filePromises = createTaskDto.files.map((file) => {
          // Extract base64 data without the data URL prefix
          const base64Data = file.base64.includes('base64,')
            ? file.base64.split('base64,')[1]
            : file.base64;

          filesDescription += `\nFile ${file.name} written to desktop.`;

          return prisma.file.create({
            data: {
              name: file.name,
              type: file.type || 'application/octet-stream',
              size: file.size,
              data: base64Data,
              taskId: task.id,
            },
          });
        });

        await Promise.all(filePromises);
        this.logger.debug(`Files saved successfully for task ID: ${task.id}`);
      }

      // Create the initial system message
      // v2.4.0: Include goal context and previous step results for autonomous operation
      this.logger.debug(`Creating initial message for task ID: ${task.id}`);

      // Build enhanced message with context for multi-step goals
      let messageText = createTaskDto.description;

      // Prepend context if this is part of a larger goal
      if (createTaskDto.goalContext || createTaskDto.previousStepResults) {
        const contextParts: string[] = [];

        if (createTaskDto.goalContext) {
          contextParts.push(`**Overall Goal:** ${createTaskDto.goalContext}`);
        }

        if (createTaskDto.previousStepResults) {
          contextParts.push(
            `**Previous Steps Completed:**\n${createTaskDto.previousStepResults}`,
          );
        }

        contextParts.push(`**Current Task:** ${createTaskDto.description}`);

        // Build the full message with context
        messageText = contextParts.join('\n\n');

        // v2.4.1: Structured logging for context propagation
        this.logger.log({
          message: 'Task created with goal context',
          taskId: task.id,
          hasGoalContext: !!createTaskDto.goalContext,
          goalContextLength: createTaskDto.goalContext?.length || 0,
          hasPreviousStepResults: !!createTaskDto.previousStepResults,
          previousStepResultsLength:
            createTaskDto.previousStepResults?.length || 0,
          enhancedMessageLength: messageText.length,
          nodeRunId: createTaskDto.nodeRunId || null,
          workspaceId: createTaskDto.workspaceId || null,
        });
      }

      // Append file description if present
      if (filesDescription) {
        messageText = `${messageText} ${filesDescription}`;
      }

      await prisma.message.create({
        data: {
          content: [
            {
              type: 'text',
              text: messageText,
            },
          ] as Prisma.InputJsonValue,
          role: Role.USER,
          taskId: task.id,
        },
      });
      this.logger.debug(`Initial message created for task ID: ${task.id}`);

      return task;
    });

    this.tasksGateway.emitTaskCreated(task);

    // v2.2.16: Generate title asynchronously if not provided
    // This runs in the background and doesn't block task creation
    if (!createTaskDto.title) {
      this.generateTitleAsync(task.id, createTaskDto.description);
    }

    return task;
  }

  /**
   * v2.2.16: Generates a title for a task asynchronously.
   * Updates the task with the generated title and emits an update event.
   * Errors are logged but don't affect the task.
   */
  private async generateTitleAsync(
    taskId: string,
    description: string,
  ): Promise<void> {
    try {
      const title =
        await this.titleGenerationService.generateTitle(description);

      // Update the task with the generated title
      const updatedTask = await this.prisma.task.update({
        where: { id: taskId },
        data: { title },
      });

      this.logger.log(`Generated title for task ${taskId}: "${title}"`);

      // Emit update so UI can refresh
      this.tasksGateway.emitTaskUpdate(taskId, updatedTask);
    } catch (error: any) {
      // Log but don't fail - title generation is non-critical
      this.logger.warn(
        `Failed to generate title for task ${taskId}: ${error.message}`,
      );
    }
  }

  async findScheduledTasks(): Promise<Task[]> {
    return this.prisma.task.findMany({
      where: {
        scheduledFor: {
          not: null,
        },
        queuedAt: null,
      },
      orderBy: [{ scheduledFor: 'asc' }],
    });
  }

  async findNextTask(): Promise<(Task & { files: File[] }) | null> {
    const task = await this.prisma.task.findFirst({
      where: {
        status: {
          in: [TaskStatus.RUNNING, TaskStatus.PENDING],
        },
      },
      orderBy: [
        { executedAt: 'asc' },
        { priority: 'desc' },
        { queuedAt: 'asc' },
        { createdAt: 'asc' },
      ],
      include: {
        files: true,
      },
    });

    if (task) {
      this.logger.log(
        `Found existing task with ID: ${task.id}, and status ${task.status}. Resuming.`,
      );
    }

    return task;
  }

  /**
   * v2.2.4: Atomically claim the next available PENDING task using SELECT FOR UPDATE SKIP LOCKED.
   *
   * This method prevents race conditions when multiple agent pods compete for tasks.
   * It uses PostgreSQL's FOR UPDATE SKIP LOCKED to:
   * 1. Lock the selected task row (preventing other transactions from modifying it)
   * 2. Skip any already-locked rows (allowing concurrent agents to claim different tasks)
   * 3. Atomically update the task status to RUNNING within the same transaction
   *
   * IMPORTANT (v2.2.4): Only claims PENDING tasks, not RUNNING tasks.
   * The previous implementation (v2.2.3) included RUNNING tasks in the query, which caused
   * a race condition: after pod-A claimed a task and its transaction committed, pod-B could
   * query and find the same RUNNING task (since the lock was released), leading to both
   * pods processing the same task simultaneously.
   *
   * Orphaned RUNNING tasks (from crashed pods) should be handled by a separate recovery
   * mechanism, not by the normal task claiming process.
   *
   * @returns The claimed task with files, or null if no task is available
   */
  async claimNextTask(): Promise<(Task & { files: File[] }) | null> {
    const podName = process.env.POD_NAME || 'unknown';
    const timestamp = new Date().toISOString();

    this.logger.log(
      `[${timestamp}] [${podName}] Attempting to claim next task`,
    );

    try {
      const claimedTask = await this.prisma.$transaction(
        async (tx) => {
          // Step 1: Select and lock the next available PENDING task using FOR UPDATE SKIP LOCKED
          // v2.2.4: Only claim PENDING tasks - RUNNING tasks should not be re-claimed here
          // This prevents the race condition where multiple pods claim the same task
          const tasks = await tx.$queryRaw<Task[]>`
          SELECT * FROM "Task"
          WHERE status = 'PENDING'
          ORDER BY priority DESC, "queuedAt" ASC NULLS LAST, "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;

          if (tasks.length === 0) {
            this.logger.debug(
              `[${timestamp}] [${podName}] No available tasks to claim`,
            );
            return null;
          }

          const task = tasks[0];
          this.logger.log(
            `[${timestamp}] [${podName}] Locked task ${task.id} (status: ${task.status}), claiming it`,
          );

          // Step 2: Atomically update the task status to RUNNING with lease info
          // v2.2.5: Set claimedBy and leaseExpiresAt for orphaned task recovery
          const leaseExpiresAt = new Date(
            Date.now() + TASK_LEASE_TIMEOUT_SECONDS * 1000,
          );
          await tx.$executeRaw`
          UPDATE "Task"
          SET status = 'RUNNING',
              "executedAt" = NOW(),
              "claimedBy" = ${podName},
              "leaseExpiresAt" = ${leaseExpiresAt},
              version = version + 1
          WHERE id = ${task.id}
        `;

          this.logger.log(
            `[${timestamp}] [${podName}] Successfully claimed task ${task.id}`,
          );

          // Step 3: Fetch the complete task with files
          const fetchedTask = await tx.task.findUnique({
            where: { id: task.id },
            include: { files: true },
          });

          return fetchedTask;
        },
        {
          // Use SERIALIZABLE isolation for maximum safety
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          // Timeout after 10 seconds if lock cannot be acquired
          timeout: 10000,
        },
      );

      // v2.2.13: Emit WebSocket event AFTER transaction completes successfully
      // This notifies connected clients that the task status changed from PENDING to RUNNING
      // The event is emitted outside the transaction to:
      // 1. Not hold the DB transaction open during WebSocket broadcast
      // 2. Only emit if the transaction committed successfully
      // 3. Ensure data consistency - we emit what was actually committed
      if (claimedTask) {
        this.logger.log(
          `[${timestamp}] [${podName}] Emitting task_updated event for task ${claimedTask.id} (status: RUNNING)`,
        );
        this.tasksGateway.emitTaskUpdate(claimedTask.id, claimedTask);
      }

      return claimedTask;
    } catch (error: any) {
      this.logger.error(
        `[${timestamp}] [${podName}] Error claiming task: ${error.message}`,
      );
      // Return null on error to allow retry on next cron cycle
      return null;
    }
  }

  async findAll(
    page = 1,
    limit = 10,
    statuses?: string[],
  ): Promise<{ tasks: Task[]; total: number; totalPages: number }> {
    this.logger.log(
      `Retrieving tasks - page: ${page}, limit: ${limit}, statuses: ${statuses?.join(',')}`,
    );

    const skip = (page - 1) * limit;

    const whereClause: Prisma.TaskWhereInput =
      statuses && statuses.length > 0
        ? { status: { in: statuses as TaskStatus[] } }
        : {};

    const [tasks, total] = await Promise.all([
      this.prisma.task.findMany({
        where: whereClause,
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where: whereClause }),
    ]);

    const totalPages = Math.ceil(total / limit);
    this.logger.debug(`Retrieved ${tasks.length} tasks out of ${total} total`);

    return { tasks, total, totalPages };
  }

  async findById(id: string): Promise<Task> {
    this.logger.log(`Retrieving task by ID: ${id}`);

    try {
      const task = await this.prisma.task.findUnique({
        where: { id },
        include: {
          files: true,
        },
      });

      if (!task) {
        this.logger.warn(`Task with ID: ${id} not found`);
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      this.logger.debug(`Retrieved task with ID: ${id}`);
      return task;
    } catch (error: any) {
      this.logger.error(`Error retrieving task ID: ${id} - ${error.message}`);
      this.logger.error(error.stack);
      throw error;
    }
  }

  /**
   * Updates a task with optimistic locking to prevent race conditions.
   *
   * v2.0.28: Implemented optimistic locking using version field.
   * Uses updateMany with version check to atomically detect concurrent modifications.
   * Retries up to MAX_UPDATE_RETRIES times on conflict.
   *
   * @param id - Task ID to update
   * @param updateTaskDto - Fields to update
   * @returns Updated task
   * @throws NotFoundException if task not found
   * @throws ConflictException if concurrent modification detected after retries
   */
  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    this.logger.log(
      `[${timestamp}] Updating task with ID: ${id} (status: ${updateTaskDto.status || 'unchanged'})`,
    );
    this.logger.debug(
      `[${timestamp}] Update data: ${JSON.stringify(updateTaskDto)}`,
    );

    let retries = 0;

    while (retries < MAX_UPDATE_RETRIES) {
      // Step 1: Read current task with version
      const existingTask = await this.findById(id);

      if (!existingTask) {
        this.logger.warn(
          `[${timestamp}] Task with ID: ${id} not found for update`,
        );
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      const currentVersion =
        (existingTask as Task & { version?: number }).version ?? 0;

      this.logger.debug(
        `[${new Date().toISOString()}] Task ${id} current state: status=${existingTask.status}, version=${currentVersion}`,
      );

      // Step 2: Atomically update only if version matches
      const result = await this.prisma.task.updateMany({
        where: {
          id,
          version: currentVersion, // Only update if version hasn't changed
        },
        data: {
          ...updateTaskDto,
          version: { increment: 1 }, // Atomically increment version
        },
      });

      // Step 3: Check if update succeeded
      if (result.count === 0) {
        retries++;
        this.logger.warn(
          `[${new Date().toISOString()}] Concurrent modification detected for task ${id}, retry ${retries}/${MAX_UPDATE_RETRIES}`,
        );

        if (retries >= MAX_UPDATE_RETRIES) {
          const errorMsg = `Task ${id} was modified by another process. Please retry.`;
          this.logger.error(
            `[${new Date().toISOString()}] ${errorMsg} (exhausted retries)`,
          );
          throw new ConflictException(errorMsg);
        }

        // Brief delay before retry (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, retries) * 50),
        );
        continue;
      }

      // Step 4: Fetch the updated task to return
      let updatedTask = await this.prisma.task.findUnique({ where: { id } });

      if (!updatedTask) {
        throw new NotFoundException(
          `Task with ID ${id} not found after update`,
        );
      }

      const endTime = Date.now();
      this.logger.log(
        `[${new Date().toISOString()}] Successfully updated task ID: ${id} (status: ${updatedTask.status}, version: ${(updatedTask as Task & { version?: number }).version}, took ${endTime - startTime}ms)`,
      );
      this.logger.debug(
        `[${new Date().toISOString()}] Updated task: ${JSON.stringify(updatedTask)}`,
      );

      // Step 5: Handle status-specific side effects
      if (updateTaskDto.status === TaskStatus.COMPLETED) {
        this.eventEmitter.emit('task.completed', { taskId: id });
      } else if (updateTaskDto.status === TaskStatus.NEEDS_HELP) {
        updatedTask = await this.takeOver(id);
      } else if (updateTaskDto.status === TaskStatus.FAILED) {
        this.logger.warn(
          `[${new Date().toISOString()}] Task ${id} marked as FAILED`,
        );
        this.eventEmitter.emit('task.failed', { taskId: id });
      }

      this.tasksGateway.emitTaskUpdate(id, updatedTask);

      return updatedTask;
    }

    // This should never be reached, but TypeScript needs it
    throw new ConflictException(
      `Task ${id} update failed after ${MAX_UPDATE_RETRIES} retries`,
    );
  }

  async delete(id: string): Promise<Task> {
    this.logger.log(`Deleting task with ID: ${id}`);

    const deletedTask = await this.prisma.task.delete({
      where: { id },
    });

    this.logger.log(`Successfully deleted task ID: ${id}`);

    this.tasksGateway.emitTaskDeleted(id);

    return deletedTask;
  }

  async addTaskMessage(taskId: string, addTaskMessageDto: AddTaskMessageDto) {
    const task = await this.findById(taskId);
    if (!task) {
      this.logger.warn(`Task with ID: ${taskId} not found for guiding`);
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    const message = await this.prisma.message.create({
      data: {
        content: [{ type: 'text', text: addTaskMessageDto.message }],
        role: Role.USER,
        taskId,
      },
    });

    this.tasksGateway.emitNewMessage(taskId, message);
    return task;
  }

  async resume(taskId: string): Promise<Task> {
    this.logger.log(`Resuming task ID: ${taskId}`);

    const task = await this.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    if (task.control !== Role.USER) {
      throw new BadRequestException(`Task ${taskId} is not under user control`);
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        control: Role.ASSISTANT,
        status: TaskStatus.RUNNING,
      },
    });

    // Use per-task desktop endpoint from Task Controller (Phase 6)
    try {
      const desktopUrl = await this.taskControllerService.getDesktopUrl(taskId);
      this.logger.log(
        `Stopping input tracking for task ${taskId} at ${desktopUrl}`,
      );
      await fetch(`${desktopUrl}/input-tracking/stop`, { method: 'POST' });
    } catch (error) {
      this.logger.error('Failed to stop input tracking', error);
    }

    // Broadcast resume event so AgentProcessor can react
    this.eventEmitter.emit('task.resume', { taskId });

    this.logger.log(`Task ${taskId} resumed`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  async takeOver(taskId: string): Promise<Task> {
    this.logger.log(`Taking over control for task ID: ${taskId}`);

    const task = await this.findById(taskId);

    if (task.control !== Role.ASSISTANT) {
      throw new BadRequestException(
        `Task ${taskId} is not under agent control`,
      );
    }

    // Guardrail: do not mutate task state if the desktop lease/session is no longer valid.
    // When Phase 6 is enabled, the task controller is the source of truth for per-task desktop
    // session existence and timeout.
    let desktopUrlForTakeover: string | null = null;
    if (this.taskControllerService.isPhase6Enabled()) {
      const availability =
        await this.taskControllerService.getDesktopTakeoverAvailability(taskId);
      if (!availability.ok) {
        throw new ConflictException({
          errorCode: 'TAKEOVER_NOT_AVAILABLE',
          message: 'Desktop takeover is not available (session expired)',
          details: {
            reason: availability.reason,
            ...(availability.details || {}),
          },
        });
      }
      desktopUrlForTakeover = availability.desktopUrl;
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        control: Role.USER,
      },
    });

    // Use per-task desktop endpoint from Task Controller (Phase 6)
    try {
      const desktopUrl =
        desktopUrlForTakeover ||
        (await this.taskControllerService.getDesktopUrl(taskId));
      this.logger.log(
        `Starting input tracking for task ${taskId} at ${desktopUrl}`,
      );
      await fetch(`${desktopUrl}/input-tracking/start`, { method: 'POST' });
    } catch (error) {
      this.logger.error('Failed to start input tracking', error);
    }

    // Broadcast takeover event so AgentProcessor can react
    this.eventEmitter.emit('task.takeover', { taskId });

    this.logger.log(`Task ${taskId} takeover initiated`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  async cancel(taskId: string): Promise<Task> {
    this.logger.log(`Cancelling task ID: ${taskId}`);

    const task = await this.findById(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    if (
      task.status === TaskStatus.COMPLETED ||
      task.status === TaskStatus.FAILED ||
      task.status === TaskStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Task ${taskId} is already completed, failed, or cancelled`,
      );
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.CANCELLED,
      },
    });

    // Broadcast cancel event so AgentProcessor can cancel processing
    this.eventEmitter.emit('task.cancel', { taskId });

    this.logger.log(`Task ${taskId} cancelled and marked as failed`);
    this.tasksGateway.emitTaskUpdate(taskId, updatedTask);

    return updatedTask;
  }

  /**
   * v2.2.5: Renew the lease for a running task.
   * Called periodically by the agent processor to indicate the task is still being worked on.
   * Extends the lease by TASK_LEASE_TIMEOUT_SECONDS from now.
   *
   * @param taskId - Task ID to renew lease for
   * @param claimedBy - Pod name that should own the lease (for validation)
   * @returns Updated task or null if lease renewal failed (task not owned by this pod)
   */
  async renewLease(taskId: string, claimedBy: string): Promise<Task | null> {
    const timestamp = new Date().toISOString();
    this.logger.debug(
      `[${timestamp}] [${claimedBy}] Renewing lease for task ${taskId}`,
    );

    try {
      const newLeaseExpiry = new Date(
        Date.now() + TASK_LEASE_TIMEOUT_SECONDS * 1000,
      );

      // Only renew if this pod owns the lease and task is still RUNNING
      const result = await this.prisma.task.updateMany({
        where: {
          id: taskId,
          status: TaskStatus.RUNNING,
          claimedBy: claimedBy,
        },
        data: {
          leaseExpiresAt: newLeaseExpiry,
        },
      });

      if (result.count === 0) {
        this.logger.warn(
          `[${timestamp}] [${claimedBy}] Failed to renew lease for task ${taskId} - not owned by this pod or not running`,
        );
        return null;
      }

      this.logger.debug(
        `[${timestamp}] [${claimedBy}] Lease renewed for task ${taskId} until ${newLeaseExpiry.toISOString()}`,
      );
      return await this.prisma.task.findUnique({ where: { id: taskId } });
    } catch (error: any) {
      this.logger.error(
        `[${timestamp}] [${claimedBy}] Error renewing lease: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * v2.2.5: Recover orphaned tasks that have expired leases.
   * Called by a cron job to find RUNNING tasks with expired leases and mark them as FAILED.
   *
   * These tasks were likely being processed by a pod that crashed or became unresponsive.
   * Marking as FAILED (rather than PENDING) is safer because:
   * - The task may have partially corrupted state
   * - Message history may be inconsistent
   * - User should review before retrying
   *
   * @returns Array of recovered task IDs
   */
  async recoverOrphanedTasks(): Promise<string[]> {
    const timestamp = new Date().toISOString();
    const podName = process.env.POD_NAME || 'unknown';
    this.logger.log(`[${timestamp}] [${podName}] Checking for orphaned tasks`);

    try {
      // Find all RUNNING tasks with expired leases
      const orphanedTasks = await this.prisma.task.findMany({
        where: {
          status: TaskStatus.RUNNING,
          leaseExpiresAt: {
            lt: new Date(), // Lease has expired
          },
        },
        select: {
          id: true,
          claimedBy: true,
          leaseExpiresAt: true,
          executedAt: true,
        },
      });

      if (orphanedTasks.length === 0) {
        this.logger.debug(
          `[${timestamp}] [${podName}] No orphaned tasks found`,
        );
        return [];
      }

      this.logger.warn(
        `[${timestamp}] [${podName}] Found ${orphanedTasks.length} orphaned task(s)`,
      );

      const recoveredIds: string[] = [];

      for (const task of orphanedTasks) {
        const leaseDuration = task.leaseExpiresAt
          ? Math.round((Date.now() - task.leaseExpiresAt.getTime()) / 1000)
          : 'unknown';

        this.logger.warn(
          `[${timestamp}] [${podName}] Recovering orphaned task ${task.id} ` +
            `(claimed by: ${task.claimedBy}, lease expired ${leaseDuration}s ago)`,
        );

        try {
          // Mark as FAILED with descriptive error
          await this.prisma.task.update({
            where: { id: task.id },
            data: {
              status: TaskStatus.FAILED,
              error: `Task orphaned - worker ${task.claimedBy} stopped responding. Lease expired at ${task.leaseExpiresAt?.toISOString()}`,
              claimedBy: null,
              leaseExpiresAt: null,
            },
          });

          recoveredIds.push(task.id);

          // Emit event for frontend notification
          this.eventEmitter.emit('task.failed', { taskId: task.id });
          this.tasksGateway.emitTaskUpdate(
            task.id,
            await this.findById(task.id),
          );

          this.logger.log(
            `[${timestamp}] [${podName}] Task ${task.id} marked as FAILED due to lease expiration`,
          );
        } catch (error: any) {
          this.logger.error(
            `[${timestamp}] [${podName}] Failed to recover task ${task.id}: ${error.message}`,
          );
        }
      }

      return recoveredIds;
    } catch (error: any) {
      this.logger.error(
        `[${timestamp}] [${podName}] Error recovering orphaned tasks: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * v2.2.5: Clear lease information when a task completes or fails.
   * Should be called when a task transitions to a terminal state.
   *
   * @param taskId - Task ID to clear lease for
   */
  async clearLease(taskId: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const podName = process.env.POD_NAME || 'unknown';

    try {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          claimedBy: null,
          leaseExpiresAt: null,
        },
      });
      this.logger.debug(
        `[${timestamp}] [${podName}] Cleared lease for task ${taskId}`,
      );
    } catch (error: any) {
      // Non-critical - log and continue
      this.logger.warn(
        `[${timestamp}] [${podName}] Failed to clear lease for task ${taskId}: ${error.message}`,
      );
    }
  }

  /**
   * v2.2.17: Backfill titles for existing tasks that don't have AI-generated titles.
   *
   * This method is idempotent - it only processes tasks where title IS NULL.
   * Uses batching with delays to avoid overwhelming the LLM proxy.
   * Individual task failures don't stop the entire backfill process.
   *
   * @param options - Optional configuration for the backfill
   * @returns Summary of the backfill operation
   */
  async backfillTitles(
    options: {
      batchSize?: number;
      delayMs?: number;
      limit?: number;
      dryRun?: boolean;
    } = {},
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    skipped: number;
    errors: Array<{ taskId: string; error: string }>;
    durationMs: number;
  }> {
    const {
      batchSize = 10,
      delayMs = 2000,
      limit = 0,
      dryRun = false,
    } = options;

    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    this.logger.log(
      `[${timestamp}] Starting title backfill (batchSize=${batchSize}, delayMs=${delayMs}, limit=${limit}, dryRun=${dryRun})`,
    );

    // Find all tasks without titles (idempotent query)
    let query = this.prisma.task.findMany({
      where: {
        title: null,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        description: true,
      },
    });

    // Apply limit if specified
    if (limit > 0) {
      query = this.prisma.task.findMany({
        where: {
          title: null,
        },
        orderBy: {
          createdAt: 'asc',
        },
        select: {
          id: true,
          description: true,
        },
        take: limit,
      });
    }

    const tasksToProcess = await query;

    const result = {
      total: tasksToProcess.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      errors: [] as Array<{ taskId: string; error: string }>,
      durationMs: 0,
    };

    if (tasksToProcess.length === 0) {
      this.logger.log(
        `[${timestamp}] No tasks without titles found. Backfill complete.`,
      );
      result.durationMs = Date.now() - startTime;
      return result;
    }

    this.logger.log(
      `[${timestamp}] Found ${tasksToProcess.length} tasks without titles`,
    );

    // Process in batches
    for (let i = 0; i < tasksToProcess.length; i += batchSize) {
      const batch = tasksToProcess.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(tasksToProcess.length / batchSize);

      this.logger.log(
        `[${new Date().toISOString()}] Processing batch ${batchNum}/${totalBatches} (${batch.length} tasks)`,
      );

      // Process batch concurrently
      const batchResults = await Promise.allSettled(
        batch.map(async (task) => {
          if (dryRun) {
            this.logger.debug(
              `[DRY RUN] Would generate title for task ${task.id}`,
            );
            return { taskId: task.id, title: '[DRY RUN - NOT GENERATED]' };
          }

          try {
            const title = await this.titleGenerationService.generateTitle(
              task.description,
            );

            // Update the task with the generated title
            await this.prisma.task.update({
              where: { id: task.id },
              data: { title },
            });

            this.logger.log(`Task ${task.id}: "${title}"`);
            return { taskId: task.id, title };
          } catch (error: any) {
            throw { taskId: task.id, error: error.message };
          }
        }),
      );

      // Process results
      for (const batchResult of batchResults) {
        if (batchResult.status === 'fulfilled') {
          result.successful++;
        } else {
          result.failed++;
          const errorInfo = batchResult.reason as {
            taskId: string;
            error: string;
          };
          result.errors.push(errorInfo);
          this.logger.warn(
            `Task ${errorInfo.taskId}: FAILED - ${errorInfo.error}`,
          );
        }
      }

      // Progress log
      const progress = (
        ((i + batch.length) / tasksToProcess.length) *
        100
      ).toFixed(1);
      this.logger.log(
        `[${new Date().toISOString()}] Progress: ${i + batch.length}/${tasksToProcess.length} (${progress}%) - ` +
          `Success: ${result.successful}, Failed: ${result.failed}`,
      );

      // Delay between batches (except for the last batch)
      if (i + batchSize < tasksToProcess.length) {
        this.logger.debug(`Waiting ${delayMs}ms before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    result.durationMs = Date.now() - startTime;
    const successRate = ((result.successful / result.total) * 100).toFixed(2);

    this.logger.log(`
===== TITLE BACKFILL COMPLETE =====
Duration: ${(result.durationMs / 1000).toFixed(2)}s
Total: ${result.total}
Successful: ${result.successful}
Failed: ${result.failed}
Success Rate: ${successRate}%
===================================
    `);

    return result;
  }
}
