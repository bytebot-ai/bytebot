/**
 * Task Controller API
 * Provides endpoints for agents to fetch task credentials and post heartbeats
 * Phase 6.4 Integration Support
 *
 * IMPORTANT: This controller implements on-demand TaskDesktop creation.
 * When an agent requests task info, if no TaskDesktop CR exists but the task
 * exists in the database, we create the TaskDesktop synchronously and claim
 * a warm pool pod. This ensures pod isolation even when the reconciler hasn't
 * had time to process the task.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KubernetesService } from '../services/kubernetes.service';
import { DatabaseService } from '../services/database.service';
import { MetricsService } from '../services/metrics.service';
import { PodClaimResult, TaskDesktop, TaskDesktopPhase } from '../interfaces/taskdesktop.interface';
import * as crypto from 'crypto';

/**
 * Response for task info endpoint
 */
interface TaskInfoResponse {
  taskId: string;
  tenantId: string;
  phase: string;
  desktopEndpoint: string | null;
  vncEndpoint: string | null;
  routerUrl: string;
  credentials: {
    apiToken: string;
    vncPassword: string;
    expiresAt: string;
  } | null;
  timeoutAt: string | null;
  startedAt: string | null;
}

/**
 * Request for heartbeat endpoint
 */
interface HeartbeatRequest {
  taskId: string;
  agentId?: string;
  status?: string;
  currentStep?: string;
  stepCount?: number;
}

/**
 * Response for heartbeat endpoint
 *
 * v1.0.6: Added `ready` field to separate "agent should stay alive" (shouldContinue)
 * from "agent can execute" (ready). This follows Kubernetes controller best practices
 * for handling race conditions during resource provisioning.
 *
 * - shouldContinue: true during setup phases (Pending, Claiming, Assigned, Running)
 *                   false only for terminal states (Completed, Failed, TimedOut, Cancelled)
 * - ready: true only when phase is Running (desktop available for execution)
 *
 * v1.0.9: Added `estimatedWaitTime` for WaitingForCapacity phase to help agents
 * decide on appropriate timeout values when waiting for capacity.
 */
interface HeartbeatResponse {
  acknowledged: boolean;
  shouldContinue: boolean;
  ready: boolean; // v1.0.6: true only when desktop is ready for execution
  phase: string; // v1.0.6: current phase for debugging
  message: string; // v1.0.6: human-readable status message
  timeRemaining: number; // seconds
  warningThreshold: boolean; // true if <5 min remaining
  estimatedWaitTime?: number; // v1.0.9: seconds remaining in capacity wait (only for WaitingForCapacity)
}

/**
 * v1.0.27: Response for task health endpoint
 *
 * Phase C (Heartbeat-based timeout): Provides heartbeat health data for orchestrator
 * to use instead of static TTL-based timeouts.
 *
 * The orchestrator polls this endpoint to determine if the agent is healthy.
 * If agentHeartbeat is stale (> HEARTBEAT_TIMEOUT_MS), the task is considered unhealthy.
 */
interface TaskHealthResponse {
  taskId: string;
  phase: string;
  agentHeartbeat: string | null;      // ISO timestamp of last agent heartbeat
  heartbeatMissedCount: number;       // Consecutive missed heartbeats tracked by reconciler
  isHeartbeatHealthy: boolean;        // true if heartbeat within timeout threshold
  lastActivityAt: string | null;      // Most recent activity (heartbeat or phase change)
  timeSinceHeartbeat: number | null;  // Seconds since last heartbeat (null if no heartbeat)
}

// v1.0.27: Heartbeat timeout configuration for health endpoint
// Agent sends heartbeat every 15 seconds. After 60 seconds (4 missed beats), consider unhealthy.
const HEARTBEAT_TIMEOUT_MS = 60000;
const TEXT_ONLY_PHASE = 'TextOnly';

/**
 * Map to track in-progress TaskDesktop creations to prevent duplicate claims
 */
const taskDesktopCreationLocks = new Map<string, Promise<TaskDesktop | null>>();

@Controller('api/v1/tasks')
export class TaskController {
  private readonly logger = new Logger(TaskController.name);
  private readonly routerServiceUrl: string;
  private readonly defaultTimeout: string = '1h';
  private readonly warmPoolSelector: Record<string, string> = {
    'bytebot.ai/pool': 'warm',
    'bytebot.ai/assigned': 'false',
  };
  // v1.0.12: Capacity wait timeout for on-demand path (consistent with reconciler)
  private readonly capacityWaitTimeoutMs: number;
  // v1.0.21: Phase 5 - Admission control configuration
  private readonly maxQueueDepth: number;
  private readonly admissionControlEnabled: boolean;

  constructor(
    private k8sService: KubernetesService,
    private dbService: DatabaseService,
    private metricsService: MetricsService,
    private configService: ConfigService,
  ) {
    this.routerServiceUrl = process.env.DESKTOP_ROUTER_URL ||
      'http://bytebot-desktop-router:8080';
    // v1.0.12: Default capacity wait timeout is 3 minutes (180000ms)
    // This allows time for KEDA to scale up overflow pods
    this.capacityWaitTimeoutMs = parseInt(
      this.configService.get<string>('CAPACITY_WAIT_TIMEOUT_MS') || '180000',
      10,
    );
    // v1.0.21: Phase 5 - Admission control configuration
    this.maxQueueDepth = parseInt(
      this.configService.get<string>('MAX_QUEUE_DEPTH') || '100',
      10,
    );
    this.admissionControlEnabled =
      this.configService.get<string>('ADMISSION_CONTROL_ENABLED') !== 'false';
  }

  /**
   * GET /api/v1/tasks/:taskId
   * Fetch task info including desktop endpoint and credentials
   *
   * This is the primary endpoint for agents to get per-task credentials
   * without mounting secrets into the long-running agent pod.
   *
   * ON-DEMAND CREATION: If no TaskDesktop exists but task exists in DB,
   * we create the TaskDesktop synchronously and claim a warm pool pod.
   * This ensures tasks get isolated desktops even when the reconciler
   * hasn't had time to process the task yet.
   */
  @Get(':taskId')
  async getTaskInfo(@Param('taskId') taskId: string): Promise<TaskInfoResponse> {
    this.logger.debug(`Fetching task info for ${taskId}`);

    // Get TaskDesktop by task ID
    let taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    // If no TaskDesktop exists, try to create one on-demand
    if (!taskDesktop) {
      const task = await this.dbService.getTask(taskId);
      if (!task) {
        throw new HttpException(
          `Task ${taskId} not found`,
          HttpStatus.NOT_FOUND,
        );
      }

      const executionSurface = this.resolveExecutionSurface(task);
      if (executionSurface === 'TEXT_ONLY') {
        this.logger.log(`Task ${taskId} is TEXT_ONLY; skipping TaskDesktop provisioning`);
        return {
          taskId: task.id,
          tenantId: task.tenantId || 'default',
          phase: TEXT_ONLY_PHASE,
          desktopEndpoint: null,
          vncEndpoint: null,
          routerUrl: this.routerServiceUrl,
          credentials: null,
          timeoutAt: null,
          startedAt: null,
        };
      }

      this.logger.log(`No TaskDesktop found for ${taskId}, attempting on-demand creation`);
      taskDesktop = await this.createTaskDesktopOnDemand(taskId);

      if (!taskDesktop) {
        throw new HttpException(
          `Task ${taskId} not found`,
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';

    // Only return credentials for active tasks
    if (!['Assigned', 'Running'].includes(phase)) {
      return {
        taskId: taskDesktop.spec.taskId,
        tenantId: taskDesktop.spec.tenantId,
        phase,
        desktopEndpoint: null,
        vncEndpoint: null,
        routerUrl: this.routerServiceUrl,
        credentials: null,
        timeoutAt: status?.timeoutAt || null,
        startedAt: status?.startedAt || null,
      };
    }

    // Check if credentials are revoked
    if (status?.credentials?.revoked) {
      throw new HttpException(
        `Credentials for task ${taskId} have been revoked`,
        HttpStatus.FORBIDDEN,
      );
    }

    // Check if credentials are expired
    if (status?.credentials?.tokenExpiresAt) {
      const expiresAt = new Date(status.credentials.tokenExpiresAt);
      if (new Date() > expiresAt) {
        throw new HttpException(
          `Credentials for task ${taskId} have expired`,
          HttpStatus.FORBIDDEN,
        );
      }
    }

    // Fetch actual credentials from secret
    const credentials = await this.k8sService.getTaskCredentials(taskId);

    return {
      taskId: taskDesktop.spec.taskId,
      tenantId: taskDesktop.spec.tenantId,
      phase,
      desktopEndpoint: status?.desktopEndpoint || null,
      vncEndpoint: status?.vncEndpoint || null,
      routerUrl: this.routerServiceUrl,
      credentials: credentials ? {
        apiToken: credentials.apiToken,
        vncPassword: credentials.vncPassword,
        expiresAt: status?.credentials?.tokenExpiresAt ||
          new Date(Date.now() + 3600000).toISOString(), // Default 1h
      } : null,
      timeoutAt: status?.timeoutAt || null,
      startedAt: status?.startedAt || null,
    };
  }

  /**
   * POST /api/v1/tasks/:taskId/heartbeat
   * Agent posts heartbeat to indicate it's still processing
   *
   * Returns whether the agent should continue or stop (e.g., cancelled/timed out)
   */
  @Post(':taskId/heartbeat')
  async postHeartbeat(
    @Param('taskId') taskId: string,
    @Body() body: HeartbeatRequest,
  ): Promise<HeartbeatResponse> {
    this.logger.debug(`Heartbeat from agent for task ${taskId}`);

    // Get TaskDesktop
    let taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    // v1.0.26: If no TaskDesktop exists, try to create one on-demand
    // This prevents race conditions where agent sends heartbeat before
    // TaskDesktop CR is created (e.g., during WaitingForCapacity phase)
    if (!taskDesktop) {
      const task = await this.dbService.getTask(taskId);
      if (!task) {
        throw new HttpException(
          `Task ${taskId} not found`,
          HttpStatus.NOT_FOUND,
        );
      }

      const executionSurface = this.resolveExecutionSurface(task);
      if (executionSurface === 'TEXT_ONLY') {
        return {
          acknowledged: true,
          shouldContinue: true,
          ready: true,
          phase: TEXT_ONLY_PHASE,
          message: 'Task is TEXT_ONLY; no desktop provisioning required',
          timeRemaining: 3600,
          warningThreshold: false,
        };
      }

      this.logger.log(`No TaskDesktop found for ${taskId} on heartbeat, attempting on-demand creation`);
      taskDesktop = await this.createTaskDesktopOnDemand(taskId);

      if (!taskDesktop) {
        throw new HttpException(
          `Task ${taskId} not found`,
          HttpStatus.NOT_FOUND,
        );
      }
    }

    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';

    // v1.0.6: Determine shouldContinue and ready based on phase
    // Following Kubernetes controller best practices:
    // - shouldContinue: true during setup phases, false only for terminal states
    // - ready: true only when desktop is available for execution
    // v1.0.9: Added WaitingForCapacity to setup phases
    const terminalPhases = ['Completed', 'Failed', 'TimedOut', 'Cancelled', 'Finalizing'];
    const setupPhases = ['Unknown', 'Pending', 'WaitingForCapacity', 'Claiming', 'Assigned'];

    const shouldContinue = !terminalPhases.includes(phase);
    const ready = phase === 'Running';

    // v1.0.9: Calculate estimated wait time for WaitingForCapacity phase
    let estimatedWaitTime: number | undefined;
    if (phase === 'WaitingForCapacity' && status?.capacityWaitTimeoutAt) {
      const timeoutAt = new Date(status.capacityWaitTimeoutAt);
      estimatedWaitTime = Math.max(0, Math.floor((timeoutAt.getTime() - Date.now()) / 1000));
    }

    // Generate human-readable message based on phase
    let message: string;
    switch (phase) {
      case 'Unknown':
        message = 'Task desktop is initializing';
        break;
      case 'Pending':
        message = 'Waiting to claim a desktop pod from warm pool';
        break;
      case 'WaitingForCapacity':
        // v1.0.9: Specific message for capacity wait phase
        message = status?.message || 'Waiting for desktop capacity to become available';
        break;
      case 'Claiming':
        message = 'Claiming desktop pod from warm pool';
        break;
      case 'Assigned':
        message = 'Desktop pod claimed, waiting for readiness';
        break;
      case 'Running':
        message = 'Desktop ready for task execution';
        break;
      case 'Finalizing':
        message = 'Task is finalizing, agent should stop';
        break;
      case 'Completed':
        message = 'Task completed successfully';
        break;
      case 'Failed':
        message = status?.message || 'Task failed';
        break;
      case 'TimedOut':
        message = 'Task timed out';
        break;
      case 'Cancelled':
        message = 'Task was cancelled';
        break;
      default:
        message = `Unknown phase: ${phase}`;
    }

    // Calculate time remaining
    let timeRemaining = 3600; // Default 1 hour
    let warningThreshold = false;

    if (status?.timeoutAt) {
      const timeoutAt = new Date(status.timeoutAt);
      timeRemaining = Math.max(0, Math.floor((timeoutAt.getTime() - Date.now()) / 1000));
      warningThreshold = timeRemaining < 300; // Less than 5 minutes
    }

    // Update agent heartbeat in TaskDesktop status (for non-terminal phases)
    if (shouldContinue && !setupPhases.includes(phase)) {
      await this.k8sService.updateTaskDesktopStatus(
        taskDesktop.metadata?.name!,
        {
          ...status,
          agentHeartbeat: new Date().toISOString(),
          heartbeatMissedCount: 0, // Reset missed count on successful heartbeat
        },
      );
    }

    this.logger.debug(
      `Heartbeat response for ${taskId}: phase=${phase}, shouldContinue=${shouldContinue}, ready=${ready}` +
      (estimatedWaitTime !== undefined ? `, estimatedWaitTime=${estimatedWaitTime}s` : ''),
    );

    return {
      acknowledged: true,
      shouldContinue,
      ready,
      phase,
      message,
      timeRemaining,
      warningThreshold,
      ...(estimatedWaitTime !== undefined && { estimatedWaitTime }), // v1.0.9: Include when in WaitingForCapacity
    };
  }

  /**
   * GET /api/v1/tasks/:taskId/health
   * v1.0.27: Phase C - Heartbeat-based health endpoint for orchestrator
   *
   * Returns heartbeat health data that the orchestrator uses to determine
   * if the agent is still alive and processing the task. This replaces
   * the static TTL-based timeout with dynamic heartbeat-based timeout.
   *
   * The orchestrator polls this endpoint every 5 seconds and uses the
   * isHeartbeatHealthy field to decide if the task should be timed out.
   */
  @Get(':taskId/health')
  async getTaskHealth(@Param('taskId') taskId: string): Promise<TaskHealthResponse> {
    this.logger.debug(`Health check for task ${taskId}`);

    const taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    if (!taskDesktop) {
      // Text-only tasks do not provision TaskDesktop resources.
      const task = await this.dbService.getTask(taskId);
      if (!task) {
        throw new HttpException(
          `Task ${taskId} not found`,
          HttpStatus.NOT_FOUND,
        );
      }

      const executionSurface = this.resolveExecutionSurface(task);
      if (executionSurface === 'TEXT_ONLY') {
        return {
          taskId,
          phase: TEXT_ONLY_PHASE,
          agentHeartbeat: null,
          heartbeatMissedCount: 0,
          isHeartbeatHealthy: true,
          lastActivityAt: task.updatedAt?.toISOString() || task.createdAt?.toISOString() || null,
          timeSinceHeartbeat: null,
        };
      }

      throw new HttpException(
        `Task ${taskId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';
    const agentHeartbeat = status?.agentHeartbeat || null;
    const heartbeatMissedCount = status?.heartbeatMissedCount || 0;

    // Calculate time since last heartbeat
    let timeSinceHeartbeat: number | null = null;
    let isHeartbeatHealthy = true;

    if (agentHeartbeat) {
      const heartbeatTime = new Date(agentHeartbeat).getTime();
      const now = Date.now();
      timeSinceHeartbeat = Math.floor((now - heartbeatTime) / 1000);

      // Heartbeat is unhealthy if stale beyond timeout threshold
      isHeartbeatHealthy = (now - heartbeatTime) < HEARTBEAT_TIMEOUT_MS;
    } else {
      // No heartbeat yet - consider healthy during setup phases, unhealthy during Running
      const setupPhases = ['Unknown', 'Pending', 'WaitingForCapacity', 'Claiming', 'Assigned'];
      isHeartbeatHealthy = setupPhases.includes(phase);
    }

    // Determine last activity time (most recent of heartbeat, phase transition, or creation)
    // All values should be ISO string format
    const creationTimestamp = taskDesktop.metadata?.creationTimestamp;
    const lastActivityAt = agentHeartbeat
      || status?.startedAt
      || (creationTimestamp instanceof Date ? creationTimestamp.toISOString() : creationTimestamp)
      || null;

    this.logger.debug(
      `Health for ${taskId}: phase=${phase}, ` +
      `heartbeat=${agentHeartbeat ? `${timeSinceHeartbeat}s ago` : 'none'}, ` +
      `healthy=${isHeartbeatHealthy}`,
    );

    return {
      taskId,
      phase,
      agentHeartbeat,
      heartbeatMissedCount,
      isHeartbeatHealthy,
      lastActivityAt,
      timeSinceHeartbeat,
    };
  }

  /**
   * POST /api/v1/tasks/:taskId/cancel
   * Request task cancellation
   */
  @Post(':taskId/cancel')
  async cancelTask(@Param('taskId') taskId: string): Promise<{ cancelled: boolean }> {
    this.logger.log(`Cancel request for task ${taskId}`);

    const taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    if (!taskDesktop) {
      throw new HttpException(
        `Task ${taskId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';

    // Can only cancel running or assigned tasks
    if (!['Assigned', 'Running'].includes(phase)) {
      throw new HttpException(
        `Cannot cancel task in phase ${phase}`,
        HttpStatus.CONFLICT,
      );
    }

    // Revoke credentials immediately
    await this.k8sService.updateTaskDesktopStatus(
      taskDesktop.metadata?.name!,
      {
        ...status,
        phase: 'Cancelled',
        credentials: {
          ...status?.credentials,
          revoked: true,
        },
        completedAt: new Date().toISOString(),
        reason: 'UserCancelled',
        message: 'Task cancelled by user request',
      },
    );

    return { cancelled: true };
  }

  /**
   * DELETE /api/v1/tasks/:taskId/desktop
   * v2.4.0: Clean up TaskDesktop resource for a task
   *
   * Called when a task transitions to NEEDS_HELP or is paused.
   * Releases the desktop pod back to the warm pool while preserving the task.
   *
   * Use cases:
   * - Task asks for user input (NEEDS_HELP) - don't hold desktop while waiting
   * - User pauses task to review - release resources
   * - Orchestrator detects task is idle - proactive cleanup
   */
  @Delete(':taskId/desktop')
  async cleanupTaskDesktop(
    @Param('taskId') taskId: string,
  ): Promise<{ cleaned: boolean; message: string }> {
    this.logger.log(`Desktop cleanup request for task ${taskId}`);

    const taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    if (!taskDesktop) {
      // No TaskDesktop exists - already cleaned up or never created.
      //
      // P1 safety: still release any orphan-claimed desktop pods by label, so we
      // never require manual warm-pool unassign after partial failures.
      const released = await this.k8sService.clearDesktopClaimsForTask(taskId);
      if (released.cleared > 0) {
        this.logger.warn(
          `Released ${released.cleared} orphan desktop claim(s) for task ${taskId}: ${released.podNames.join(', ')}`,
        );
        this.metricsService.incrementOrphanDesktopClaimsCleared(released.cleared);
      }

      try {
        await this.k8sService.deleteTaskSecret(taskId);
      } catch (error: any) {
        // Best-effort; credentials may already be gone.
        this.logger.warn(
          `Failed to delete credentials secret for task ${taskId}: ${error.message}`,
        );
      }

      return {
        cleaned: true,
        message:
          released.cleared > 0
            ? `No TaskDesktop found; released ${released.cleared} orphan desktop claim(s)`
            : 'No TaskDesktop found - already cleaned or task did not require desktop',
      };
    }

    const name = taskDesktop.metadata?.name;
    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';

    // Only clean up if in Running or Assigned phase
    // Don't interfere with terminal phases or pending phases
    if (!['Running', 'Assigned'].includes(phase)) {
      this.logger.debug(`TaskDesktop ${name} in phase ${phase}, no cleanup needed`);
      return {
        cleaned: false,
        message: `TaskDesktop in phase ${phase} - no cleanup performed`,
      };
    }

    try {
      // Transition to Finalizing phase to trigger cleanup
      await this.k8sService.updateTaskDesktopStatus(name!, {
        ...status,
        phase: 'Finalizing',
        reason: 'DesktopCleanupRequested',
        message: 'Desktop cleanup requested - task paused for user input',
        finishedAt: new Date().toISOString(),
      });

      this.logger.log(`TaskDesktop ${name} transitioned to Finalizing for cleanup`);

      return {
        cleaned: true,
        message: `TaskDesktop ${name} marked for cleanup`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to cleanup TaskDesktop ${name}: ${error.message}`);
      throw new HttpException(
        `Failed to cleanup desktop: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/tasks/:taskId/extend
   * Request timeout extension (if allowed)
   */
  @Post(':taskId/extend')
  async extendTimeout(
    @Param('taskId') taskId: string,
    @Body() body: { additionalMinutes: number },
  ): Promise<{ newTimeoutAt: string }> {
    this.logger.log(`Extend timeout request for task ${taskId}`);

    const taskDesktop = await this.k8sService.getTaskDesktopByTaskId(taskId);

    if (!taskDesktop) {
      throw new HttpException(
        `Task ${taskId} not found`,
        HttpStatus.NOT_FOUND,
      );
    }

    const status = taskDesktop.status;
    const phase = status?.phase || 'Unknown';

    if (phase !== 'Running') {
      throw new HttpException(
        `Cannot extend timeout for task in phase ${phase}`,
        HttpStatus.CONFLICT,
      );
    }

    // Calculate new timeout (max 2 hours total)
    const currentTimeout = status?.timeoutAt
      ? new Date(status.timeoutAt)
      : new Date(Date.now() + 3600000);

    const additionalMs = Math.min(body.additionalMinutes || 30, 60) * 60 * 1000;
    const startedAt = status?.startedAt ? new Date(status.startedAt) : new Date();
    const maxDuration = 2 * 60 * 60 * 1000; // 2 hours max

    const newTimeoutAt = new Date(Math.min(
      currentTimeout.getTime() + additionalMs,
      startedAt.getTime() + maxDuration,
    ));

    // Update timeout
    await this.k8sService.updateTaskDesktopStatus(
      taskDesktop.metadata?.name!,
      {
        ...status,
        timeoutAt: newTimeoutAt.toISOString(),
      },
    );

    return { newTimeoutAt: newTimeoutAt.toISOString() };
  }

  /**
   * Create a TaskDesktop on-demand when agent requests task info
   *
   * This method is called when:
   * 1. Agent requests task info via GET /api/v1/tasks/:taskId
   * 2. No TaskDesktop CR exists yet (reconciler hasn't processed it)
   * 3. Task exists in the database
   *
   * The method:
   * 1. Checks if task exists in database
   * 2. Uses a lock to prevent concurrent creations for the same task
   * 3. Creates TaskDesktop CR
   * 4. Claims a warm pool pod
   * 5. Creates credentials secret
   * 6. Updates TaskDesktop status with pod info
   */
  private async createTaskDesktopOnDemand(taskId: string): Promise<TaskDesktop | null> {
    // v1.0.21: Phase 5 - Check admission control before creating TaskDesktop
    if (this.admissionControlEnabled) {
      const pendingCount = await this.dbService.countPendingTasks();
      if (pendingCount >= this.maxQueueDepth) {
        this.logger.warn(
          `[Phase 5] Admission denied for task ${taskId}: queue at capacity ` +
          `(${pendingCount}/${this.maxQueueDepth}). Returning 429 Too Many Requests.`,
        );
        this.metricsService.incrementTasksRejected();
        this.metricsService.incrementAdmissionQueueFull();

        // Calculate retry-after based on estimated drain time (30s per task, 3 tasks processed in parallel)
        const estimatedRetryAfter = Math.max(30, Math.ceil((pendingCount - this.maxQueueDepth + 10) * 10));

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: `System at capacity. ${pendingCount} tasks pending, max queue depth is ${this.maxQueueDepth}. Retry after ${estimatedRetryAfter} seconds.`,
            retryAfter: estimatedRetryAfter,
            pendingTasks: pendingCount,
            maxQueueDepth: this.maxQueueDepth,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Check if task exists in database
    const task = await this.dbService.getTask(taskId);
    if (!task) {
      this.logger.debug(`Task ${taskId} not found in database`);
      return null;
    }

    // Use a lock to prevent concurrent creations for the same task
    // This prevents multiple requests from claiming multiple pods
    const existingLock = taskDesktopCreationLocks.get(taskId);
    if (existingLock) {
      this.logger.debug(`Waiting for existing TaskDesktop creation for ${taskId}`);
      return existingLock;
    }

    // Create a promise that handles the creation
    const creationPromise = this.doCreateTaskDesktopOnDemand(taskId, task);
    taskDesktopCreationLocks.set(taskId, creationPromise);

    try {
      const result = await creationPromise;
      return result;
    } finally {
      // Clean up the lock after completion (with a small delay to handle racing requests)
      setTimeout(() => taskDesktopCreationLocks.delete(taskId), 5000);
    }
  }

  /**
   * Internal method to actually create the TaskDesktop
   */
  private async doCreateTaskDesktopOnDemand(
    taskId: string,
    task: { id: string; tenantId?: string; priority?: string },
  ): Promise<TaskDesktop | null> {
    const name = `task-${taskId}`;
    const tenantId = task.tenantId || 'default';
    const finalizerName = 'taskdesktop.bytebot.ai/finalizer';

    this.logger.log(`Creating TaskDesktop on-demand for task ${taskId}`);

    // Check again if TaskDesktop was created by reconciler in the meantime
    const existing = await this.k8sService.getTaskDesktopByTaskId(taskId);
    if (existing) {
      this.logger.debug(`TaskDesktop already exists for ${taskId}`);
      return existing;
    }

    try {
      // Step 1: Create the TaskDesktop CR
      const taskDesktop: TaskDesktop = {
        apiVersion: 'bytebot.ai/v1alpha1',
        kind: 'TaskDesktop',
        metadata: {
          name,
          namespace: this.k8sService.getNamespace(),
          labels: {
            'bytebot.ai/task-id': taskId,
            'bytebot.ai/tenant-id': tenantId,
          },
          finalizers: [finalizerName],
        },
        spec: {
          taskId,
          tenantId,
          tier: 'professional',
          timeout: this.defaultTimeout,
          priority: this.priorityToNumber(task.priority),
        },
        status: {
          phase: 'Pending',
          conditions: [],
          retryCount: 0,
          history: [
            {
              timestamp: new Date().toISOString(),
              fromPhase: '',
              toPhase: 'Pending',
              reason: 'CreatedOnDemand',
            },
          ],
        },
      };

      let createdTaskDesktop: TaskDesktop;
      try {
        createdTaskDesktop = await this.k8sService.createTaskDesktop(taskDesktop);
        this.logger.log(`Created TaskDesktop ${name}`);
      } catch (error: any) {
        if (error.statusCode === 409) {
          // Already exists (created by reconciler), fetch it
          this.logger.debug(`TaskDesktop ${name} already exists, fetching`);
          const existing = await this.k8sService.getTaskDesktop(name);
          return existing;
        }
        throw error;
      }

      // Step 2: Find and claim a warm pool pod
      const warmPods = await this.k8sService.listAvailableWarmPods(this.warmPoolSelector);
      if (warmPods.length === 0) {
        // v1.0.12: FIX - Transition to WaitingForCapacity instead of staying in Pending
        // This is critical for KEDA scaling triggers to work
        this.logger.warn(`No warm pods available for ${name}, transitioning to WaitingForCapacity`);

        // Calculate capacity wait timeout (consistent with reconciler)
        const capacityWaitStartedAt = new Date();
        const capacityWaitTimeoutAt = new Date(Date.now() + this.capacityWaitTimeoutMs);

        // v1.0.12: Immediately increment gauge so KEDA sees it without waiting
        // This is critical for triggering overflow pool scaling
        this.metricsService.incrementTasksWaitingForCapacityGauge();
        this.metricsService.incrementTasksWaitedForCapacity();
        this.metricsService.incrementNoWarmPodsAvailable();

        // Update status to WaitingForCapacity phase
        await this.k8sService.updateTaskDesktopStatus(name, {
          phase: 'WaitingForCapacity',
          message: 'Waiting for desktop capacity to become available',
          reason: 'NoPodsAvailable',
          capacityWaitStartedAt: capacityWaitStartedAt.toISOString(),
          capacityWaitTimeoutAt: capacityWaitTimeoutAt.toISOString(),
          conditions: [{
            type: 'PodClaimed',
            status: 'False',
            lastTransitionTime: capacityWaitStartedAt.toISOString(),
            reason: 'NoPodsAvailable',
            message: 'No warm pool pods available, waiting for capacity',
          }],
          history: [
            {
              timestamp: capacityWaitStartedAt.toISOString(),
              fromPhase: 'Pending',
              toPhase: 'WaitingForCapacity',
              reason: 'NoPodsAvailable',
            },
          ],
        });

        this.logger.log(
          `TaskDesktop ${name} transitioned to WaitingForCapacity, timeout at ${capacityWaitTimeoutAt.toISOString()}`,
        );

        // Return the TaskDesktop - reconciler will check for available overflow pods
        return this.k8sService.getTaskDesktop(name);
      }

      // Claim a ready warm pod; preflight bytebotd before returning it to the task.
      let claimResult: PodClaimResult | null = null;
      for (const pod of warmPods) {
        const podName = pod.metadata?.name;
        if (!podName) {
          continue;
        }

        const result = await this.k8sService.claimPodWithDesktopPreflight(
          podName,
          taskId,
          tenantId,
          name,
        );

        if (result.success) {
          claimResult = result;
          break;
        }

        if (result.error === 'desktop_preflight_failed') {
          this.metricsService.incrementDesktopPreflightFailed();
          continue;
        }

        this.metricsService.incrementPodsClaimFailed();
      }

      if (!claimResult?.success) {
        this.logger.error(`Failed to claim any ready warm pod for ${name}`);
        // Update status and let reconciler retry.
        await this.k8sService.updateTaskDesktopStatus(name, {
          phase: 'Pending',
          message: 'Failed to claim a ready warm pod',
          retryCount: 1,
        });
        return this.k8sService.getTaskDesktop(name);
      }

      // Step 3: Generate and store credentials
      const credentials = {
        vncPassword: crypto.randomBytes(8).toString('hex'),
        apiToken: crypto.randomBytes(32).toString('hex'),
      };
      const secretName = await this.k8sService.createTaskSecret(
        taskId,
        tenantId,
        credentials,
      );

      // Step 4: Calculate timeout
      const timeoutAt = this.calculateTimeout(this.defaultTimeout);

      // Step 5: Update TaskDesktop status with all pod info
      const updatedTaskDesktop = await this.k8sService.updateTaskDesktopStatus(name, {
        phase: 'Running',
        podName: claimResult.podName,
        podIP: claimResult.podIP,
        podUID: claimResult.podUID,
        desktopEndpoint: `http://${claimResult.podIP}:9990`,
        vncEndpoint: `ws://${claimResult.podIP}:6080`,
        credentials: {
          secretName,
          vncPassword: 'vnc-password',
          apiToken: 'api-token',
        },
        assignedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        timeoutAt: timeoutAt.toISOString(),
        conditions: [
          {
            type: 'PodClaimed',
            status: 'True',
            lastTransitionTime: new Date().toISOString(),
            reason: 'PodClaimedOnDemand',
            message: `Claimed pod ${claimResult.podName} via on-demand creation`,
          },
          {
            type: 'PodReady',
            status: 'True',
            lastTransitionTime: new Date().toISOString(),
            reason: 'PodReady',
            message: 'Pod is ready for task execution',
          },
        ],
        history: [
          {
            timestamp: new Date().toISOString(),
            fromPhase: '',
            toPhase: 'Pending',
            reason: 'CreatedOnDemand',
          },
          {
            timestamp: new Date().toISOString(),
            fromPhase: 'Pending',
            toPhase: 'Running',
            reason: 'PodClaimedOnDemand',
          },
        ],
      });

      this.logger.log(
        `TaskDesktop ${name} created on-demand with pod ${claimResult.podName} (IP: ${claimResult.podIP})`,
      );

      return updatedTaskDesktop;
    } catch (error: any) {
      this.logger.error(`Failed to create TaskDesktop on-demand for ${taskId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Convert priority string to number
   */
  private priorityToNumber(priority: string | undefined): number {
    switch (priority) {
      case 'URGENT':
        return 500;
      case 'HIGH':
        return 200;
      case 'MEDIUM':
        return 100;
      case 'LOW':
        return 50;
      default:
        return 100;
    }
  }

  /**
   * Calculate timeout date from timeout string (e.g., "1h", "30m")
   */
  private calculateTimeout(timeout: string): Date {
    const now = new Date();
    const match = timeout.match(/^(\d+)(s|m|h)$/);
    if (!match) {
      return new Date(now.getTime() + 60 * 60 * 1000); // Default 1 hour
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    let ms: number;
    switch (unit) {
      case 's':
        ms = value * 1000;
        break;
      case 'm':
        ms = value * 60 * 1000;
        break;
      case 'h':
        ms = value * 60 * 60 * 1000;
        break;
      default:
        ms = 60 * 60 * 1000;
    }

    return new Date(now.getTime() + ms);
  }

  private resolveExecutionSurface(task: {
    requiresDesktop: boolean;
    executionSurface?: string | null;
  }): 'TEXT_ONLY' | 'DESKTOP' {
    if (task.executionSurface === 'TEXT_ONLY' || task.executionSurface === 'DESKTOP') {
      return task.executionSurface;
    }
    return task.requiresDesktop ? 'DESKTOP' : 'TEXT_ONLY';
  }
}
