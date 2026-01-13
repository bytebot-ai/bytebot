/**
 * Database Service
 * Handles database interactions for task management
 *
 * v1.0.20: Added connection pool limits to prevent database exhaustion
 * - connection_limit: Max connections per instance (default: 2)
 * - pool_timeout: Max seconds to wait for connection (default: 30)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { DatabaseTask, TaskPriorityEnum, TaskTypeEnum, RoleEnum } from '../interfaces/taskdesktop.interface';

/**
 * Build datasource URL with connection pool parameters
 */
function buildDatasourceUrl(baseUrl: string, connectionLimit: number, poolTimeout: number): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('connection_limit', connectionLimit.toString());
    url.searchParams.set('pool_timeout', poolTimeout.toString());
    return url.toString();
  } catch {
    return baseUrl;
  }
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private prisma: PrismaClient;

  constructor(private configService: ConfigService) {
    const baseUrl = this.configService.get<string>('DATABASE_URL') || '';
    const connectionLimit = parseInt(this.configService.get<string>('DB_CONNECTION_LIMIT') || '2', 10);
    const poolTimeout = parseInt(this.configService.get<string>('DB_POOL_TIMEOUT') || '30', 10);

    const datasourceUrl = buildDatasourceUrl(baseUrl, connectionLimit, poolTimeout);

    this.prisma = new PrismaClient({
      datasourceUrl,
      log: ['error', 'warn'],
    });

    this.logger.log(
      `DatabaseService initialized with connection_limit=${connectionLimit}, pool_timeout=${poolTimeout}`,
    );
  }

  async onModuleInit() {
    await this.prisma.$connect();
    this.logger.log('Connected to database');
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
    this.logger.log('Disconnected from database');
  }

  /**
   * Get pending tasks that need desktop assignment
   * Tasks with status PENDING that don't have an active TaskDesktop
   */
  async getPendingTasks(
    batchSize: number = 10,
    excludeTaskIds: string[] = [],
  ): Promise<DatabaseTask[]> {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'PENDING',
        // Desktop provisioning is only for tasks that actually require a desktop.
        // executionSurface (nullable) overrides requiresDesktop when present.
        OR: [
          { executionSurface: 'DESKTOP' },
          { executionSurface: null, requiresDesktop: true },
        ],
        // Exclude tasks that already have TaskDesktop resources
        id: {
          notIn: excludeTaskIds,
        },
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' },
      ],
      take: batchSize,
    });

    return tasks.map((task) => ({
      id: task.id,
      description: task.description,
      type: task.type as TaskTypeEnum,
      status: task.status as DatabaseTask['status'],
      priority: task.priority as TaskPriorityEnum,
      control: task.control as RoleEnum,
      requiresDesktop: task.requiresDesktop,
      executionSurface: task.executionSurface as DatabaseTask['executionSurface'],
      model: task.model as unknown,
      version: task.version,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      tenantId: (task as any).tenantId, // May exist in extended schema
    }));
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    taskId: string,
    status: DatabaseTask['status'],
    version: number,
  ): Promise<boolean> {
    try {
      // Optimistic locking with version check
      const result = await this.prisma.task.updateMany({
        where: {
          id: taskId,
          version: version,
        },
        data: {
          status: status,
          version: version + 1,
          updatedAt: new Date(),
        },
      });

      return result.count > 0;
    } catch (error) {
      this.logger.error(`Failed to update task ${taskId} status: ${error}`);
      return false;
    }
  }

  /**
   * Get task by ID
   */
  async getTask(taskId: string): Promise<DatabaseTask | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
    });

    if (!task) return null;

    return {
      id: task.id,
      description: task.description,
      type: task.type as TaskTypeEnum,
      status: task.status as DatabaseTask['status'],
      priority: task.priority as TaskPriorityEnum,
      control: task.control as RoleEnum,
      requiresDesktop: task.requiresDesktop,
      executionSurface: task.executionSurface as DatabaseTask['executionSurface'],
      model: task.model as unknown,
      version: task.version,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      tenantId: (task as any).tenantId,
    };
  }

  /**
   * Get running tasks
   */
  async getRunningTasks(): Promise<DatabaseTask[]> {
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'RUNNING',
      },
    });

    return tasks.map((task) => ({
      id: task.id,
      description: task.description,
      type: task.type as TaskTypeEnum,
      status: task.status as DatabaseTask['status'],
      priority: task.priority as TaskPriorityEnum,
      control: task.control as RoleEnum,
      requiresDesktop: task.requiresDesktop,
      executionSurface: task.executionSurface as DatabaseTask['executionSurface'],
      model: task.model as unknown,
      version: task.version,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      tenantId: (task as any).tenantId,
    }));
  }

  /**
   * Mark task as failed
   */
  async markTaskFailed(taskId: string, reason: string): Promise<boolean> {
    try {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'FAILED',
          updatedAt: new Date(),
        },
      });
      return true;
    } catch (error) {
      this.logger.error(`Failed to mark task ${taskId} as failed: ${error}`);
      return false;
    }
  }

  /**
   * Mark task as completed
   */
  async markTaskCompleted(taskId: string): Promise<boolean> {
    try {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: 'COMPLETED',
          updatedAt: new Date(),
        },
      });
      return true;
    } catch (error) {
      this.logger.error(`Failed to mark task ${taskId} as completed: ${error}`);
      return false;
    }
  }

  // ==========================================================================
  // v1.0.21: Phase 5 - Admission control methods
  // ==========================================================================

  /**
   * Count total pending tasks in the database
   * Used for admission control and backpressure decisions
   */
  async countPendingTasks(): Promise<number> {
    try {
      const count = await this.prisma.task.count({
        where: {
          status: 'PENDING',
          // Desktop provisioning queue only counts desktop-requiring tasks.
          OR: [
            { executionSurface: 'DESKTOP' },
            { executionSurface: null, requiresDesktop: true },
          ],
        },
      });
      return count;
    } catch (error) {
      this.logger.error(`Failed to count pending tasks: ${error}`);
      return 0;
    }
  }

  /**
   * Count tasks by status for admission metrics
   * Returns counts for pending, running, and waiting for capacity
   */
  async getTaskStatusCounts(): Promise<{
    pending: number;
    running: number;
    waitingForCapacity: number;
  }> {
    try {
      const [pending, running] = await Promise.all([
        this.prisma.task.count({ where: { status: 'PENDING' } }),
        this.prisma.task.count({ where: { status: 'RUNNING' } }),
      ]);

      return {
        pending,
        running,
        waitingForCapacity: 0, // This is tracked via TaskDesktop CRs, not DB
      };
    } catch (error) {
      this.logger.error(`Failed to get task status counts: ${error}`);
      return { pending: 0, running: 0, waitingForCapacity: 0 };
    }
  }
}
