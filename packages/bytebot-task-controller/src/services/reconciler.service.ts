/**
 * Reconciler Service
 * Main reconciliation loop for TaskDesktop resources
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { KubernetesService } from './kubernetes.service';
import { DatabaseService } from './database.service';
import {
  LeaderElectionService,
  LEADER_ELECTED_EVENT,
  LEADER_LOST_EVENT,
} from './leader-election.service';
import { MetricsService } from './metrics.service';
import {
  TaskDesktop,
  TaskDesktopPhase,
  TaskDesktopStatus,
  TaskDesktopCondition,
  PodClaimResult,
  ReconcileResult,
  DatabaseTask,
  TaskPriorityEnum,
} from '../interfaces/taskdesktop.interface';

/**
 * Convert task priority enum to numeric value
 */
const priorityToNumber = (priority: TaskPriorityEnum | undefined): number => {
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
};

import * as crypto from 'crypto';

@Injectable()
export class ReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(ReconcilerService.name);
  private isRunning = false;
  private pollInterval: number;
  private batchSize: number;
  private warmPoolSelector: Record<string, string>;
  // v1.0.10: Overflow pool selector for KEDA-scaled burst capacity
  private overflowPoolSelector: Record<string, string>;
  private defaultTimeout: string;
  private finalizerName: string;
  // v1.0.9: Capacity wait timeout for overflow pool support
  private capacityWaitTimeoutMs: number;
  // v1.0.21: Phase 5 - Admission control configuration
  private maxQueueDepth: number;
  private admissionControlEnabled: boolean;
  // v1.0.24: TTL for completed/failed TaskDesktop CRs before deletion
  // This prevents 404 race conditions where orchestrator polls after CR is deleted
  private ttlAfterCompletionMs: number;
  private ttlAfterFailureMs: number;

  // P1: orphan-claim cleanup (release assigned=true pods with no authoritative owner)
  private orphanClaimCleanupIntervalMs: number;
  private orphanClaimGraceMs: number;
  private lastOrphanClaimCleanupAtMs: number = 0;

  constructor(
    private k8sService: KubernetesService,
    private dbService: DatabaseService,
    private leaderService: LeaderElectionService,
    private metricsService: MetricsService,
    private configService: ConfigService,
  ) {
    this.pollInterval = parseInt(
      this.configService.get<string>('POLL_INTERVAL') || '5000',
      10,
    );
    this.batchSize = parseInt(
      this.configService.get<string>('BATCH_SIZE') || '10',
      10,
    );
    this.warmPoolSelector = {
      'bytebot.ai/pool': 'warm',
      'bytebot.ai/assigned': 'false',
    };
    // v1.0.10: Overflow pool selector for KEDA-scaled burst capacity pods
    this.overflowPoolSelector = {
      'bytebot.ai/pool': 'overflow',
      'bytebot.ai/assigned': 'false',
    };
    this.defaultTimeout = this.configService.get<string>('DEFAULT_TIMEOUT') || '1h';
    this.finalizerName = 'taskdesktop.bytebot.ai/finalizer';
    // v1.0.9: Default capacity wait timeout is 3 minutes (180000ms)
    // This allows time for KEDA to scale up overflow pods
    this.capacityWaitTimeoutMs = parseInt(
      this.configService.get<string>('CAPACITY_WAIT_TIMEOUT_MS') || '180000',
      10,
    );
    // v1.0.21: Phase 5 - Admission control configuration
    // MAX_QUEUE_DEPTH: Maximum number of pending tasks before backpressure kicks in
    // Default: 100 tasks - prevents unbounded queue growth
    this.maxQueueDepth = parseInt(
      this.configService.get<string>('MAX_QUEUE_DEPTH') || '100',
      10,
    );
    // ADMISSION_CONTROL_ENABLED: Toggle for admission control (default: true)
    this.admissionControlEnabled =
      this.configService.get<string>('ADMISSION_CONTROL_ENABLED') !== 'false';

    this.logger.log(
      `Admission control: enabled=${this.admissionControlEnabled}, maxQueueDepth=${this.maxQueueDepth}`,
    );

    // v1.0.24: TTL configuration for delayed CR deletion
    // Default: 60 seconds for completed, 180 seconds for failed (for debugging)
    // This ensures orchestrator has ~12 poll opportunities to detect terminal state
    this.ttlAfterCompletionMs = parseInt(
      this.configService.get<string>('TASKDESKTOP_TTL_AFTER_COMPLETION_MS') || '60000',
      10,
    );
    this.ttlAfterFailureMs = parseInt(
      this.configService.get<string>('TASKDESKTOP_TTL_AFTER_FAILURE_MS') || '180000',
      10,
    );

    this.logger.log(
      `CR TTL: completion=${this.ttlAfterCompletionMs}ms, failure=${this.ttlAfterFailureMs}ms`,
    );

    // P1: orphan-claim cleanup defaults (safe + low churn)
    this.orphanClaimCleanupIntervalMs = parseInt(
      this.configService.get<string>('ORPHAN_CLAIM_CLEANUP_INTERVAL_MS') || '30000',
      10,
    );
    this.orphanClaimGraceMs = parseInt(
      this.configService.get<string>('ORPHAN_CLAIM_CLEANUP_GRACE_MS') || '60000',
      10,
    );
    this.logger.log(
      `Orphan claim cleanup: interval=${this.orphanClaimCleanupIntervalMs}ms, grace=${this.orphanClaimGraceMs}ms`,
    );
  }

  async onModuleInit() {
    this.logger.log('Reconciler service initialized');
  }

  @OnEvent(LEADER_ELECTED_EVENT)
  handleLeaderElected() {
    this.logger.log('Became leader, starting reconciliation');
    this.isRunning = true;
  }

  @OnEvent(LEADER_LOST_EVENT)
  handleLeaderLost() {
    this.logger.warn('Lost leadership, stopping reconciliation');
    this.isRunning = false;
  }

  /**
   * Main reconciliation loop - runs every 5 seconds
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async reconcileLoop() {
    if (!this.isRunning || !this.leaderService.isCurrentLeader()) {
      return;
    }

    const startTime = Date.now();
    this.logger.debug('Starting reconciliation cycle');

    try {
      // Step 1: Get existing TaskDesktop resources
      const taskDesktops = await this.k8sService.listTaskDesktops();
      const existingTaskIds = new Set(
        taskDesktops.items.map((td) => td.spec.taskId),
      );

      // v1.0.21: Phase 5 - Check admission control before processing new tasks
      const totalPendingCount = await this.dbService.countPendingTasks();
      this.metricsService.updateAdmissionMetrics(totalPendingCount, this.maxQueueDepth);

      // Check if we're at capacity (queue depth limit reached)
      const atCapacity = this.admissionControlEnabled && totalPendingCount >= this.maxQueueDepth;
      if (atCapacity) {
        this.logger.warn(
          `[Phase 5] Admission control: queue at capacity (${totalPendingCount}/${this.maxQueueDepth}). ` +
          `New task processing paused until queue drains.`,
        );
        this.metricsService.incrementAdmissionQueueFull();
      }

      // Step 2: Get pending tasks from database
      // v1.0.21: Only process new tasks if not at capacity
      const pendingTasks = atCapacity
        ? [] // Skip creating new TaskDesktops when at capacity
        : await this.dbService.getPendingTasks(
            this.batchSize,
            Array.from(existingTaskIds),
          );

      // Step 3: Create TaskDesktop for new pending tasks
      for (const task of pendingTasks) {
        await this.createTaskDesktop(task);
      }

      // Step 4: Reconcile existing TaskDesktop resources
      // Note: This always runs to progress existing tasks, even when admission is blocked
      for (const td of taskDesktops.items) {
        await this.reconcileTaskDesktop(td);
      }

      // v1.0.9: Update pool metrics for Prometheus/KEDA scaling
      await this.updatePoolMetrics(taskDesktops.items);

      // P1: release orphan claimed pods (assigned=true) that have no valid owner.
      await this.cleanupOrphanedDesktopClaims(taskDesktops.items);

      this.metricsService.recordReconcileCycle(Date.now() - startTime);
    } catch (error) {
      this.logger.error(`Reconciliation cycle failed: ${error}`);
      this.metricsService.incrementReconcileErrors();
    }
  }

  /**
   * Create a new TaskDesktop for a pending task
   */
  private async createTaskDesktop(task: DatabaseTask): Promise<void> {
    const executionSurface =
      task.executionSurface === 'TEXT_ONLY' || task.executionSurface === 'DESKTOP'
        ? task.executionSurface
        : task.requiresDesktop
          ? 'DESKTOP'
          : 'TEXT_ONLY';

    if (executionSurface === 'TEXT_ONLY') {
      this.logger.debug(
        `Skipping TaskDesktop creation for TEXT_ONLY task ${task.id}`,
      );
      return;
    }

    const name = `task-${task.id}`;

    this.logger.log(`Creating TaskDesktop for task ${task.id}`);

    const taskDesktop: TaskDesktop = {
      apiVersion: 'bytebot.ai/v1alpha1',
      kind: 'TaskDesktop',
      metadata: {
        name,
        namespace: this.k8sService.getNamespace(),
        labels: {
          'bytebot.ai/task-id': task.id,
          'bytebot.ai/tenant-id': task.tenantId || 'default',
        },
        finalizers: [this.finalizerName],
      },
      spec: {
        taskId: task.id,
        tenantId: task.tenantId || 'default',
        tier: 'professional',
        timeout: this.defaultTimeout,
        priority: priorityToNumber(task.priority),
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
            reason: 'Created',
          },
        ],
      },
    };

    try {
      await this.k8sService.createTaskDesktop(taskDesktop);
      this.metricsService.incrementTaskDesktopsCreated();
      this.logger.log(`Created TaskDesktop ${name}`);
    } catch (error: any) {
      if (error.statusCode === 409) {
        this.logger.debug(`TaskDesktop ${name} already exists`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Reconcile a single TaskDesktop resource
   */
  private async reconcileTaskDesktop(td: TaskDesktop): Promise<ReconcileResult> {
    // v1.0.7: Check for deletion first - Kubernetes best practice
    // When deletionTimestamp is set, Kubernetes has marked the object for deletion
    // but finalizers prevent actual deletion until they are removed.
    // We must handle cleanup regardless of current phase.
    if (td.metadata?.deletionTimestamp) {
      this.logger.log(
        `TaskDesktop ${td.metadata?.name} has deletionTimestamp, handling deletion cleanup`
      );
      return await this.handleDeletion(td);
    }

    const phase = td.status?.phase || 'Pending';
    this.logger.debug(`Reconciling TaskDesktop ${td.metadata?.name} in phase ${phase}`);

    try {
      switch (phase) {
        case 'Pending':
          return await this.handlePending(td);
        case 'WaitingForCapacity':
          return await this.handleWaitingForCapacity(td);
        case 'Claiming':
          return await this.handleClaiming(td);
        case 'Assigned':
          return await this.handleAssigned(td);
        case 'Running':
          return await this.handleRunning(td);
        case 'Finalizing':
          return await this.handleFinalizing(td);
        case 'Completed':
        case 'Failed':
        case 'TimedOut':
          return await this.handleTerminal(td);
        default:
          this.logger.warn(`Unknown phase ${phase} for TaskDesktop ${td.metadata?.name}`);
          return { requeue: false };
      }
    } catch (error: any) {
      this.logger.error(
        `Error reconciling TaskDesktop ${td.metadata?.name}: ${error.message}`,
      );
      return { requeue: true, requeueAfter: 5000, error };
    }
  }

  /**
   * Handle Pending phase - claim a warm pool pod
   *
   * v1.0.9: When no warm pods are available, instead of just requeueing,
   * transition to WaitingForCapacity phase. This allows:
   * 1. The agent to know it's waiting for capacity (not just timing out)
   * 2. KEDA to be triggered via metrics to scale overflow pool
   * 3. Longer wait times without task timeout
   */
  private async handlePending(td: TaskDesktop): Promise<ReconcileResult> {
    const name = td.metadata?.name!;

    // v1.0.10: Check warm pool first, then overflow pool.
    // We only consider Ready pods; exec probes enforce "ready means usable desktop".
    const warmPods = await this.k8sService.listAvailableWarmPods(this.warmPoolSelector);

    let candidatePods = warmPods;
    let poolType: 'warm' | 'overflow' = 'warm';

    if (candidatePods.length > 0) {
      this.logger.debug(`Found ${candidatePods.length} warm pods`);
    } else {
      this.logger.debug(`No warm pods available for ${name}, checking overflow pool`);
      const overflowPods = await this.k8sService.listAvailableWarmPods(this.overflowPoolSelector);
      candidatePods = overflowPods;
      poolType = 'overflow';
      if (candidatePods.length > 0) {
        this.logger.log(`Using overflow pool for ${name} (${candidatePods.length} pods available)`);
      }
    }

    // If no pods available in either pool, transition to WaitingForCapacity.
    if (candidatePods.length === 0) {
      this.logger.warn(`No pods available in warm or overflow pools for ${name}, transitioning to WaitingForCapacity`);
      this.metricsService.incrementNoWarmPodsAvailable();

      // Calculate capacity wait timeout
      const capacityWaitTimeoutAt = new Date(Date.now() + this.capacityWaitTimeoutMs);

      await this.updateStatus(td, {
        phase: 'WaitingForCapacity',
        reason: 'NoPodsAvailable',
        message: 'Waiting for desktop capacity to become available',
        capacityWaitStartedAt: new Date().toISOString(),
        capacityWaitTimeoutAt: capacityWaitTimeoutAt.toISOString(),
        history: [
          ...(td.status?.history || []),
          {
            timestamp: new Date().toISOString(),
            fromPhase: td.status?.phase || 'Pending',
            toPhase: 'WaitingForCapacity',
            reason: 'NoPodsAvailable',
          },
        ].slice(-20), // Keep last 20 entries
      });

      // v1.0.9: Track tasks that entered WaitingForCapacity for Prometheus/KEDA
      this.metricsService.incrementTasksWaitedForCapacity();

      // v1.0.11: Immediately increment gauge so KEDA sees it without waiting for next reconcile
      this.metricsService.incrementTasksWaitingForCapacityGauge();

      // Requeue to check for available pods
      return { requeue: true, requeueAfter: 5000 };
    }

    // Transition to Claiming now that we know pods are available.
    await this.updatePhase(td, 'Claiming', `StartingPodClaim_${poolType}`);
    let claimResult: PodClaimResult | null = null;
    let lastClaimError: string | undefined;
    for (const pod of candidatePods) {
      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }

      const result = await this.k8sService.claimPodWithDesktopPreflight(
        podName,
        td.spec.taskId,
        td.spec.tenantId,
        name,
      );

      if (result.success) {
        claimResult = result;
        break;
      }
      lastClaimError = result.error;

      if (result.error === 'desktop_preflight_failed') {
        this.metricsService.incrementDesktopPreflightFailed();
        continue;
      }

      this.metricsService.incrementPodsClaimFailed();
    }

    if (!claimResult?.success) {
      this.logger.error(`Failed to claim any ready ${poolType} pod for ${name}`);

      // Increment retry count
      const retryCount = (td.status?.retryCount || 0) + 1;
      if (retryCount >= 3) {
        await this.updatePhase(td, 'Failed', 'MaxRetriesExceeded', {
          retryCount,
          message: `Failed to claim pod after ${retryCount} attempts`,
        });
        return { requeue: false };
      }

      await this.updateStatus(td, {
        phase: 'Pending',
        retryCount,
        message: `Retry ${retryCount}: ${lastClaimError || 'claim_failed'}`,
      });

      return { requeue: true, requeueAfter: 1000 };
    }

    // Generate credentials
    const credentials = this.generateCredentials();
    const secretName = await this.k8sService.createTaskSecret(
      td.spec.taskId,
      td.spec.tenantId,
      credentials,
    );

    // Calculate timeout
    const timeoutAt = this.calculateTimeout(td.spec.timeout || this.defaultTimeout);

    // Update status with pod info
    await this.updateStatus(td, {
      phase: 'Assigned',
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
      timeoutAt: timeoutAt.toISOString(),
      conditions: this.setCondition(td.status?.conditions || [], {
        type: 'PodClaimed',
        status: 'True',
        lastTransitionTime: new Date().toISOString(),
        reason: 'PodClaimedSuccessfully',
        message: `Claimed ${poolType} pool pod ${claimResult.podName}`,
      }),
      // v1.0.10: Track which pool the pod came from
      poolType,
    });

    // v1.0.10: Track claims by pool type
    if (poolType === 'overflow') {
      this.metricsService.incrementOverflowPodsClaimedSuccessfully();
      this.logger.log(`TaskDesktop ${name} claimed overflow pod ${claimResult.podName}`);
    } else {
      this.metricsService.incrementPodsClaimedSuccessfully();
      this.logger.log(`TaskDesktop ${name} claimed warm pod ${claimResult.podName}`);
    }

    return { requeue: true, requeueAfter: 1000 };
  }

  /**
   * Handle Claiming phase (transient, should quickly move to Assigned)
   */
  private async handleClaiming(td: TaskDesktop): Promise<ReconcileResult> {
    // If stuck in Claiming, go back to Pending
    if (td.status?.assignedAt) {
      return { requeue: true, requeueAfter: 1000 };
    }

    await this.updatePhase(td, 'Pending', 'RetryingClaim');
    return { requeue: true, requeueAfter: 1000 };
  }

  /**
   * v1.0.9: Handle WaitingForCapacity phase - wait for pod capacity
   * v1.0.10: Now checks both warm and overflow pools
   *
   * This phase is entered when no warm pool pods are available.
   * The task waits here until:
   * 1. A warm pod becomes available (transition to Pending to claim)
   * 2. An overflow pod becomes available (transition to Pending to claim)
   * 3. The capacity wait timeout is reached (transition to Failed)
   *
   * This phase allows KEDA to scale overflow pods based on pending tasks.
   */
  private async handleWaitingForCapacity(td: TaskDesktop): Promise<ReconcileResult> {
    const name = td.metadata?.name!;

    // Check for capacity wait timeout
    if (td.status?.capacityWaitTimeoutAt) {
      const timeoutAt = new Date(td.status.capacityWaitTimeoutAt);
      if (new Date() > timeoutAt) {
        this.logger.error(`TaskDesktop ${name} capacity wait timed out`);
        // v1.0.9: Track capacity wait timeouts for Prometheus alerting
        this.metricsService.incrementCapacityWaitTimeout();
        // v1.0.11: Immediately decrement gauge - exiting WaitingForCapacity
        this.metricsService.decrementTasksWaitingForCapacityGauge();
        await this.updatePhase(td, 'Failed', 'CapacityWaitTimeout', {
          message: 'No desktop capacity available within timeout period',
        });
        await this.dbService.markTaskFailed(td.spec.taskId, 'CapacityWaitTimeout');
        return { requeue: false };
      }
    }

    // v1.0.10: Check for available pods in both pools
    const warmPods = await this.k8sService.listAvailableWarmPods(
      this.warmPoolSelector,
    );

    // Calculate wait time for logging
    const waitedMs = td.status?.capacityWaitStartedAt
      ? Date.now() - new Date(td.status.capacityWaitStartedAt).getTime()
      : 0;

    if (warmPods.length > 0) {
      // Warm pod available! Transition back to Pending to claim it
      this.logger.log(`Warm pod available for ${name} after ${Math.round(waitedMs / 1000)}s, transitioning to Pending`);

      // v1.0.11: Immediately decrement gauge - exiting WaitingForCapacity
      this.metricsService.decrementTasksWaitingForCapacityGauge();

      await this.updateStatus(td, {
        phase: 'Pending',
        reason: 'WarmCapacityAvailable',
        message: `Warm pool capacity available after waiting ${Math.round(waitedMs / 1000)}s`,
        // Clear capacity wait fields
        capacityWaitStartedAt: undefined,
        capacityWaitTimeoutAt: undefined,
        history: [
          ...(td.status?.history || []),
          {
            timestamp: new Date().toISOString(),
            fromPhase: 'WaitingForCapacity',
            toPhase: 'Pending',
            reason: `WarmCapacityAvailable after ${Math.round(waitedMs / 1000)}s`,
          },
        ].slice(-20),
      });

      // Requeue immediately to process the Pending phase
      return { requeue: true, requeueAfter: 0 };
    }

    // v1.0.10: Check overflow pool for available pods (KEDA-scaled)
    const overflowPods = await this.k8sService.listAvailableWarmPods(
      this.overflowPoolSelector,
    );

    if (overflowPods.length > 0) {
      // Overflow pod available! Transition to Pending to claim it
      this.logger.log(`Overflow pod available for ${name} after ${Math.round(waitedMs / 1000)}s, transitioning to Pending`);

      // v1.0.11: Immediately decrement gauge - exiting WaitingForCapacity
      this.metricsService.decrementTasksWaitingForCapacityGauge();

      await this.updateStatus(td, {
        phase: 'Pending',
        reason: 'OverflowCapacityAvailable',
        message: `Overflow pool capacity available after waiting ${Math.round(waitedMs / 1000)}s`,
        // Clear capacity wait fields
        capacityWaitStartedAt: undefined,
        capacityWaitTimeoutAt: undefined,
        history: [
          ...(td.status?.history || []),
          {
            timestamp: new Date().toISOString(),
            fromPhase: 'WaitingForCapacity',
            toPhase: 'Pending',
            reason: `OverflowCapacityAvailable after ${Math.round(waitedMs / 1000)}s`,
          },
        ].slice(-20),
      });

      // Requeue immediately to process the Pending phase
      return { requeue: true, requeueAfter: 0 };
    }

    // No pods available in either pool, update wait status and requeue
    const remainingMs = td.status?.capacityWaitTimeoutAt
      ? new Date(td.status.capacityWaitTimeoutAt).getTime() - Date.now()
      : this.capacityWaitTimeoutMs;

    this.logger.debug(
      `TaskDesktop ${name} still waiting for capacity: waited ${Math.round(waitedMs / 1000)}s, ` +
      `remaining ${Math.round(remainingMs / 1000)}s`,
    );

    // Update message with current wait status
    await this.updateStatus(td, {
      message: `Waiting for desktop capacity (${Math.round(waitedMs / 1000)}s elapsed, ` +
        `${Math.round(remainingMs / 1000)}s remaining)`,
    });

    // Requeue to check again in 5 seconds
    return { requeue: true, requeueAfter: 5000 };
  }

  /**
   * Handle Assigned phase - verify pod is ready, transition to Running
   */
  private async handleAssigned(td: TaskDesktop): Promise<ReconcileResult> {
    const podName = td.status?.podName;
    if (!podName) {
      await this.updatePhase(td, 'Failed', 'NoPodAssigned');
      return { requeue: false };
    }

    // Check pod status
    const pod = await this.k8sService.getPod(podName);
    if (!pod) {
      this.logger.error(`Pod ${podName} not found for TaskDesktop ${td.metadata?.name}`);
      await this.updatePhase(td, 'Failed', 'PodNotFound');
      return { requeue: false };
    }

    // Check if pod is ready
    const isReady = pod.status?.conditions?.some(
      (c) => c.type === 'Ready' && c.status === 'True',
    );

    if (!isReady) {
      // Check for timeout
      if (this.isTimedOut(td)) {
        await this.updatePhase(td, 'TimedOut', 'PodNotReadyTimeout');
        return { requeue: false };
      }
      return { requeue: true, requeueAfter: 2000 };
    }

    // Pod is ready, transition to Running
    await this.updateStatus(td, {
      phase: 'Running',
      startedAt: new Date().toISOString(),
      conditions: this.setCondition(td.status?.conditions || [], {
        type: 'PodReady',
        status: 'True',
        lastTransitionTime: new Date().toISOString(),
        reason: 'PodReady',
        message: 'Pod is ready for task execution',
      }),
    });

    // Update task in database to RUNNING
    await this.dbService.updateTaskStatus(
      td.spec.taskId,
      'RUNNING',
      0, // Version check - may need to get current version
    );

    this.metricsService.incrementTasksStarted();
    this.logger.log(`TaskDesktop ${td.metadata?.name} transitioned to Running`);

    return { requeue: true, requeueAfter: 5000 };
  }

  /**
   * Handle Running phase - monitor for completion or timeout
   */
  private async handleRunning(td: TaskDesktop): Promise<ReconcileResult> {
    // Check for timeout
    if (this.isTimedOut(td)) {
      this.logger.warn(`TaskDesktop ${td.metadata?.name} timed out`);
      await this.updatePhase(td, 'TimedOut', 'TaskTimeout');
      await this.dbService.markTaskFailed(td.spec.taskId, 'Timeout');
      return { requeue: true };
    }

    // Check task status in database
    const task = await this.dbService.getTask(td.spec.taskId);
    if (!task) {
      this.logger.warn(`Task ${td.spec.taskId} not found in database`);
      await this.updatePhase(td, 'Failed', 'TaskNotFound');
      return { requeue: false };
    }

    // Check if task completed or failed in database
    if (task.status === 'COMPLETED') {
      await this.updatePhase(td, 'Finalizing', 'TaskCompleted', {
        conditions: this.setCondition(td.status?.conditions || [], {
          type: 'TaskCompleted',
          status: 'True',
          lastTransitionTime: new Date().toISOString(),
          reason: 'TaskCompletedSuccessfully',
          message: 'Task completed in database',
        }),
      });
      return { requeue: true };
    }

    if (task.status === 'FAILED' || task.status === 'CANCELLED') {
      await this.updatePhase(td, 'Finalizing', 'TaskFailed', {
        message: `Task ${task.status.toLowerCase()} in database`,
      });
      return { requeue: true };
    }

    // Update heartbeat
    await this.updateStatus(td, {
      lastHeartbeat: new Date().toISOString(),
    });

    return { requeue: true, requeueAfter: 5000 };
  }

  /**
   * Handle Finalizing phase - upload artifacts and cleanup
   */
  private async handleFinalizing(td: TaskDesktop): Promise<ReconcileResult> {
    const name = td.metadata?.name!;

    // For now, skip artifact upload (implement later with MinIO)
    this.logger.log(`Finalizing TaskDesktop ${name}`);

    // Delete the pod using UID precondition to avoid deleting replacement pods
    if (td.status?.podName && td.status?.podUID) {
      const result = await this.k8sService.releasePodWithUID(
        td.status.podName,
        td.status.podUID,
      );
      if (result.reason === 'uid_mismatch_labels_cleared') {
        // v1.0.8: releasePodWithUID now clears labels on UID mismatch
        this.logger.log(
          `Pod ${td.status.podName} was replaced by StatefulSet. Labels cleared on replacement.`
        );
      }
    } else if (td.status?.podName) {
      // Fallback for older TaskDesktops without podUID
      // v1.0.8: Try to delete, but clear labels first as safety measure
      this.logger.warn(`TaskDesktop ${name} has no podUID, attempting deletion with label clear fallback`);
      try {
        await this.k8sService.releasePod(td.status.podName);
      } catch (error: any) {
        // If deletion fails, at least clear the labels
        this.logger.error(`Failed to delete pod ${td.status.podName}, clearing labels: ${error.message}`);
        await this.k8sService.clearPodLabels(td.status.podName);
      }
    }

    // Delete credentials secret
    await this.k8sService.deleteTaskSecret(td.spec.taskId);

    // Mark as completed
    // v1.0.24: Set finishedAt for TTL-based CR garbage collection
    const now = new Date().toISOString();
    await this.updateStatus(td, {
      phase: 'Completed',
      completedAt: now,
      finishedAt: now,
      conditions: this.setCondition(td.status?.conditions || [], {
        type: 'Finalized',
        status: 'True',
        lastTransitionTime: now,
        reason: 'CleanupComplete',
        message: 'Resources cleaned up successfully',
      }),
    });

    this.metricsService.incrementTasksCompleted();
    this.logger.log(`TaskDesktop ${name} finalized (TTL deletion in ${this.ttlAfterCompletionMs}ms)`);

    // v1.0.24: Requeue to handle TTL-based deletion
    return { requeue: true, requeueAfter: this.ttlAfterCompletionMs };
  }

  /**
   * Handle terminal phases - cleanup if needed
   * v1.0.24: Implements TTL-based CR deletion to prevent 404 race conditions
   *
   * The CR is NOT deleted immediately after entering terminal state.
   * Instead, it remains observable for a configurable TTL period, allowing
   * downstream pollers (orchestrator) to reliably detect the terminal state.
   *
   * Sequence:
   * 1. Pod cleanup and finalizer removal happen immediately
   * 2. CR deletion is delayed by TTL (default: 60s for completed, 180s for failed)
   * 3. Only after TTL expires is the CR deleted
   *
   * This eliminates the "404 because GC was too fast" failure mode.
   */
  private async handleTerminal(td: TaskDesktop): Promise<ReconcileResult> {
    const name = td.metadata?.name!;
    const phase = td.status?.phase || 'Completed';
    const finalizers = td.metadata?.finalizers || [];

    // Step 1: Remove finalizer and cleanup pod (if not already done)
    if (finalizers.includes(this.finalizerName)) {
      // Ensure cleanup happened - use UID check to avoid deleting replacement pods
      if (td.status?.podName && td.status?.podUID) {
        const result = await this.k8sService.releasePodWithUID(
          td.status.podName,
          td.status.podUID,
        );
        if (result.reason === 'uid_mismatch_labels_cleared') {
          // v1.0.8: Pod was replaced by StatefulSet - labels cleared on replacement
          this.logger.log(
            `TaskDesktop ${name}: Pod ${td.status.podName} was replaced. ` +
            `Labels cleared on replacement pod.`
          );
        }
      } else if (td.status?.podName) {
        // No UID stored - clear labels as safety measure
        // v1.0.8: Added clearPodLabels call for pods without stored UID
        const pod = await this.k8sService.getPod(td.status.podName);
        if (pod) {
          this.logger.warn(
            `TaskDesktop ${name}: Pod ${td.status.podName} exists but no podUID stored. ` +
            `Clearing labels as safety measure.`
          );
          await this.k8sService.clearPodLabels(td.status.podName);
        }
      }

      // Remove finalizer by patching the resource
      try {
        const updatedFinalizers = finalizers.filter((f) => f !== this.finalizerName);
        await this.k8sService.patchTaskDesktopFinalizers(name, updatedFinalizers);
        this.logger.log(`Removed finalizer from TaskDesktop ${name}`);
      } catch (error: any) {
        this.logger.error(`Failed to remove finalizer from ${name}: ${error.message}`);
        return { requeue: true, requeueAfter: 5000 };
      }

      // v1.0.24: Set finishedAt if not already set (for TTL calculation)
      if (!td.status?.finishedAt) {
        await this.updateStatus(td, {
          finishedAt: new Date().toISOString(),
        });
      }
    }

    // Step 2: Check TTL before deleting CR
    // v1.0.24: Delay CR deletion to allow orchestrator to poll terminal state
    const finishedAt = td.status?.finishedAt
      ? new Date(td.status.finishedAt)
      : new Date();

    // Use longer TTL for failed tasks (helps with debugging)
    const ttl = (phase === 'Failed' || phase === 'TimedOut')
      ? this.ttlAfterFailureMs
      : this.ttlAfterCompletionMs;

    const elapsedMs = Date.now() - finishedAt.getTime();
    const remainingMs = ttl - elapsedMs;

    if (remainingMs > 0) {
      // TTL not expired - requeue to check again later
      this.logger.debug(
        `TaskDesktop ${name} in ${phase} phase, TTL expires in ${Math.ceil(remainingMs / 1000)}s`
      );
      return { requeue: true, requeueAfter: remainingMs };
    }

    // Step 3: TTL expired - safe to delete CR
    try {
      await this.k8sService.deleteTaskDesktop(name);
      this.logger.log(
        `Deleted TaskDesktop CR ${name} after TTL (${Math.ceil(elapsedMs / 1000)}s since ${phase})`
      );
    } catch (error: any) {
      // Log error but don't requeue - CR may already be gone
      if (error.statusCode === 404) {
        this.logger.debug(`TaskDesktop ${name} already deleted`);
      } else {
        this.logger.error(`Failed to delete TaskDesktop ${name}: ${error.message}`);
      }
    }

    return { requeue: false };
  }

  /**
   * v1.0.7: Handle deletion - cleanup when deletionTimestamp is set
   *
   * This method runs when a TaskDesktop CR is being deleted (kubectl delete or
   * programmatic deletion). Per Kubernetes best practices, we check for
   * deletionTimestamp BEFORE routing to phase handlers, ensuring cleanup
   * happens regardless of the current phase.
   *
   * This fixes the bug where manually deleted CRs would remain stuck because
   * they stayed in non-terminal phases (e.g., "Running") and handleTerminal()
   * was never called.
   */
  private async handleDeletion(td: TaskDesktop): Promise<ReconcileResult> {
    const name = td.metadata?.name!;
    const finalizers = td.metadata?.finalizers || [];

    // If our finalizer is present, we must do cleanup before removal
    if (finalizers.includes(this.finalizerName)) {
      this.logger.log(`Performing cleanup for deleted TaskDesktop ${name}`);

      // Release the pod if assigned - use UID precondition to avoid deleting replacements
      if (td.status?.podName && td.status?.podUID) {
        const result = await this.k8sService.releasePodWithUID(
          td.status.podName,
          td.status.podUID,
        );
        if (result.reason === 'uid_mismatch_labels_cleared') {
          // v1.0.8: releasePodWithUID now clears labels on UID mismatch
          this.logger.log(
            `TaskDesktop ${name}: Pod ${td.status.podName} was replaced by StatefulSet. ` +
            `Labels cleared on replacement pod.`
          );
        } else if (result.deleted) {
          this.logger.log(`Released pod ${td.status.podName} for deleted TaskDesktop ${name}`);
        }
      } else if (td.status?.podName) {
        // No UID stored - clear labels on the pod as a safety measure
        // v1.0.8: Added clearPodLabels call for pods without stored UID
        this.logger.warn(
          `TaskDesktop ${name}: Pod ${td.status.podName} exists but no podUID stored. ` +
          `Clearing labels as safety measure.`
        );
        await this.k8sService.clearPodLabels(td.status.podName);
      }

      // Delete credentials secret
      try {
        await this.k8sService.deleteTaskSecret(td.spec.taskId);
        this.logger.debug(`Deleted credentials secret for TaskDesktop ${name}`);
      } catch (error: any) {
        // Log but continue - secret may already be gone
        this.logger.debug(`Could not delete secret for ${name}: ${error.message}`);
      }

      // Remove finalizer to allow deletion to complete
      try {
        const updatedFinalizers = finalizers.filter((f) => f !== this.finalizerName);
        await this.k8sService.patchTaskDesktopFinalizers(name, updatedFinalizers);
        this.logger.log(`Removed finalizer from deleted TaskDesktop ${name}, deletion will complete`);
      } catch (error: any) {
        this.logger.error(`Failed to remove finalizer from ${name}: ${error.message}`);
        return { requeue: true, requeueAfter: 5000 };
      }
    } else {
      this.logger.debug(`TaskDesktop ${name} has no finalizer, deletion will complete`);
    }

    // No requeue - Kubernetes will complete the deletion now that finalizer is removed
    return { requeue: false };
  }

  /**
   * Helper: Update TaskDesktop phase
   */
  private async updatePhase(
    td: TaskDesktop,
    phase: TaskDesktopPhase,
    reason: string,
    additionalStatus?: Partial<TaskDesktopStatus>,
  ): Promise<void> {
    const oldPhase = td.status?.phase || 'Unknown';
    const history = td.status?.history || [];
    history.push({
      timestamp: new Date().toISOString(),
      fromPhase: oldPhase,
      toPhase: phase,
      reason,
    });

    // Keep only last 20 history entries
    const trimmedHistory = history.slice(-20);

    await this.updateStatus(td, {
      phase,
      reason,
      history: trimmedHistory,
      ...additionalStatus,
    });
  }

  /**
   * Helper: Update TaskDesktop status
   */
  private async updateStatus(
    td: TaskDesktop,
    status: Partial<TaskDesktopStatus>,
  ): Promise<void> {
    await this.k8sService.updateTaskDesktopStatus(
      td.metadata?.name!,
      {
        ...td.status,
        ...status,
        observedGeneration: td.metadata?.generation,
      },
    );
  }

  /**
   * Helper: Set or update a condition
   */
  private setCondition(
    conditions: TaskDesktopCondition[],
    newCondition: TaskDesktopCondition,
  ): TaskDesktopCondition[] {
    const existing = conditions.findIndex((c) => c.type === newCondition.type);
    if (existing >= 0) {
      conditions[existing] = newCondition;
    } else {
      conditions.push(newCondition);
    }
    return conditions;
  }

  /**
   * Helper: Check if task is timed out
   */
  private isTimedOut(td: TaskDesktop): boolean {
    if (!td.status?.timeoutAt) return false;
    return new Date() > new Date(td.status.timeoutAt);
  }

  /**
   * Helper: Calculate timeout date
   */
  private calculateTimeout(timeout: string): Date {
    const now = new Date();
    const match = timeout.match(/^(\d+)(s|m|h)$/);
    if (!match) {
      // Default to 1 hour
      return new Date(now.getTime() + 60 * 60 * 1000);
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

  /**
   * Helper: Generate random credentials
   */
  private generateCredentials(): { vncPassword: string; apiToken: string } {
    return {
      vncPassword: crypto.randomBytes(8).toString('hex'),
      apiToken: crypto.randomBytes(32).toString('hex'),
    };
  }

  /**
   * v1.0.9: Update pool metrics for Prometheus/KEDA scaling
   * v1.0.10: Now includes overflow pool metrics
   *
   * This method updates gauge metrics that KEDA uses for autoscaling decisions:
   * - task_controller_tasks_waiting_for_capacity: Primary KEDA trigger
   * - task_controller_warm_pods_available: Available warm pool pods
   * - task_controller_warm_pods_total: Total warm pool pods
   * - task_controller_overflow_pods_available: Available overflow pool pods
   * - task_controller_overflow_pods_total: Total overflow pool pods
   * - task_controller_active_taskdesktops: Active TaskDesktop count
   */
  private async updatePoolMetrics(_taskDesktops: TaskDesktop[]): Promise<void> {
    try {
      // v1.0.11: Re-fetch TaskDesktops to get accurate phase counts
      // This is a safety reconciliation - the passed parameter may be stale
      // because phases are updated during reconcileTaskDesktop() calls
      const freshTaskDesktops = await this.k8sService.listTaskDesktops();

      // Count TaskDesktops in WaitingForCapacity phase (using fresh data)
      const tasksWaitingForCapacity = freshTaskDesktops.items.filter(
        (td) => td.status?.phase === 'WaitingForCapacity',
      ).length;

      // Count active TaskDesktops (not in terminal phases)
      const terminalPhases = ['Completed', 'Failed', 'TimedOut'];
      const activeTaskDesktops = freshTaskDesktops.items.filter(
        (td) => td.status?.phase && !terminalPhases.includes(td.status.phase),
      ).length;

      // Get warm pool pod counts
      // Available pods: pool=warm AND assigned=false
      const availableWarmPods = await this.k8sService.listAvailableWarmPods(
        this.warmPoolSelector,
      );
      const warmPodsAvailable = availableWarmPods.length;

      // Total warm pods: all pods with pool=warm label (regardless of assigned status)
      const allWarmPods = await this.k8sService.listAvailableWarmPods({
        'bytebot.ai/pool': 'warm',
      });
      const warmPodsTotal = allWarmPods.length;

      // v1.0.10: Get overflow pool pod counts
      // Available pods: pool=overflow AND assigned=false
      const availableOverflowPods = await this.k8sService.listAvailableWarmPods(
        this.overflowPoolSelector,
      );
      const overflowPodsAvailable = availableOverflowPods.length;

      // Total overflow pods: all pods with pool=overflow label (regardless of assigned status)
      const allOverflowPods = await this.k8sService.listAvailableWarmPods({
        'bytebot.ai/pool': 'overflow',
      });
      const overflowPodsTotal = allOverflowPods.length;

      // Update all metrics atomically
      this.metricsService.updatePoolMetrics(
        warmPodsAvailable,
        warmPodsTotal,
        tasksWaitingForCapacity,
        activeTaskDesktops,
        overflowPodsAvailable,
        overflowPodsTotal,
      );

      this.logger.debug(
        `Pool metrics updated: waiting=${tasksWaitingForCapacity}, ` +
        `warmAvailable=${warmPodsAvailable}/${warmPodsTotal}, ` +
        `overflowAvailable=${overflowPodsAvailable}/${overflowPodsTotal}, ` +
        `active=${activeTaskDesktops}`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to update pool metrics: ${error.message}`);
      // Don't throw - metrics failure shouldn't break reconciliation
    }
  }

  private async cleanupOrphanedDesktopClaims(taskDesktops: TaskDesktop[]): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastOrphanClaimCleanupAtMs < this.orphanClaimCleanupIntervalMs) {
      return;
    }
    this.lastOrphanClaimCleanupAtMs = nowMs;

    const taskDesktopByTaskId = new Map<string, TaskDesktop>();
    for (const td of taskDesktops) {
      taskDesktopByTaskId.set(td.spec.taskId, td);
    }

    const claimedPods = await this.k8sService.listClaimedDesktopPods();
    if (claimedPods.length === 0) {
      return;
    }

    const terminalPhases = new Set<TaskDesktopPhase>([
      'Completed',
      'Failed',
      'TimedOut',
      'Cancelled',
    ]);

    let cleared = 0;
    for (const pod of claimedPods) {
      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }

      // Skip pods recently claimed to avoid interfering with in-flight provisioning.
      const claimedAtRaw = pod.metadata?.annotations?.['bytebot.ai/claimed-at'];
      if (claimedAtRaw) {
        const claimedAtMs = Date.parse(claimedAtRaw);
        if (!Number.isNaN(claimedAtMs) && nowMs - claimedAtMs < this.orphanClaimGraceMs) {
          continue;
        }
      }

      const taskId = pod.metadata?.labels?.['bytebot.ai/task-id'];
      if (!taskId) {
        this.logger.warn(
          `Clearing orphan claim: pod ${podName} is assigned=true but has no bytebot.ai/task-id`,
        );
        await this.k8sService.clearPodLabels(podName);
        cleared += 1;
        continue;
      }

      const td = taskDesktopByTaskId.get(taskId);
      if (!td) {
        this.logger.warn(
          `Clearing orphan claim: pod ${podName} assigned to task ${taskId} but TaskDesktop is missing`,
        );
        await this.k8sService.clearPodLabels(podName);
        cleared += 1;
        continue;
      }

      const phase = td.status?.phase;
      if (phase && terminalPhases.has(phase)) {
        this.logger.warn(
          `Clearing stale claim: pod ${podName} assigned to task ${taskId} but TaskDesktop phase=${phase}`,
        );
        await this.k8sService.clearPodLabels(podName);
        cleared += 1;
        continue;
      }

      // If TaskDesktop explicitly points at a different pod, this pod is stale.
      if (td.status?.podName && td.status.podName !== podName) {
        this.logger.warn(
          `Clearing stale claim: pod ${podName} assigned to task ${taskId} but TaskDesktop points to ${td.status.podName}`,
        );
        await this.k8sService.clearPodLabels(podName);
        cleared += 1;
      }
    }

    if (cleared > 0) {
      this.metricsService.incrementOrphanDesktopClaimsCleared(cleared);
      this.logger.warn(`Orphan desktop claims cleared: ${cleared}`);
    }
  }
}
