/**
 * Metrics Service
 * Prometheus metrics for the Task Controller
 */

import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Gauge, Histogram } from 'prom-client';

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric('task_controller_reconcile_cycles_total')
    private reconcileCyclesTotal: Counter<string>,

    @InjectMetric('task_controller_reconcile_errors_total')
    private reconcileErrorsTotal: Counter<string>,

    @InjectMetric('task_controller_reconcile_duration_seconds')
    private reconcileDuration: Histogram<string>,

    @InjectMetric('task_controller_taskdesktops_created_total')
    private taskDesktopsCreatedTotal: Counter<string>,

    @InjectMetric('task_controller_pods_claimed_total')
    private podsClaimedTotal: Counter<string>,

    // v1.0.10: Track overflow pool claims separately
    @InjectMetric('task_controller_overflow_pods_claimed_total')
    private overflowPodsClaimedTotal: Counter<string>,

    @InjectMetric('task_controller_pods_claim_failed_total')
    private podsClaimFailedTotal: Counter<string>,

    @InjectMetric('task_controller_desktop_preflight_failed_total')
    private desktopPreflightFailedTotal: Counter<string>,

    @InjectMetric('task_controller_orphan_desktop_claims_cleared_total')
    private orphanDesktopClaimsClearedTotal: Counter<string>,

    @InjectMetric('task_controller_no_warm_pods_total')
    private noWarmPodsTotal: Counter<string>,

    @InjectMetric('task_controller_tasks_started_total')
    private tasksStartedTotal: Counter<string>,

    @InjectMetric('task_controller_tasks_completed_total')
    private tasksCompletedTotal: Counter<string>,

    @InjectMetric('task_controller_tasks_failed_total')
    private tasksFailedTotal: Counter<string>,

    @InjectMetric('task_controller_tasks_timed_out_total')
    private tasksTimedOutTotal: Counter<string>,

    // v1.0.9: Metrics for overflow pool scaling (Phase 2)
    @InjectMetric('task_controller_tasks_waited_for_capacity_total')
    private tasksWaitedForCapacityTotal: Counter<string>,

    @InjectMetric('task_controller_capacity_wait_timeout_total')
    private capacityWaitTimeoutTotal: Counter<string>,

    @InjectMetric('task_controller_active_taskdesktops')
    private activeTaskDesktops: Gauge<string>,

    @InjectMetric('task_controller_warm_pods_available')
    private warmPodsAvailable: Gauge<string>,

    // v1.0.9: Metrics for overflow pool scaling (Phase 2)
    @InjectMetric('task_controller_tasks_waiting_for_capacity')
    private tasksWaitingForCapacity: Gauge<string>,

    @InjectMetric('task_controller_warm_pods_total')
    private warmPodsTotal: Gauge<string>,

    // v1.0.10: Track overflow pool availability
    @InjectMetric('task_controller_overflow_pods_available')
    private overflowPodsAvailable: Gauge<string>,

    @InjectMetric('task_controller_overflow_pods_total')
    private overflowPodsTotal: Gauge<string>,

    @InjectMetric('task_controller_is_leader')
    private isLeader: Gauge<string>,

    // v1.0.21: Phase 5 - Admission control metrics
    @InjectMetric('task_controller_tasks_rejected_total')
    private tasksRejectedTotal: Counter<string>,

    @InjectMetric('task_controller_admission_queue_full_total')
    private admissionQueueFullTotal: Counter<string>,

    @InjectMetric('task_controller_pending_tasks')
    private pendingTasks: Gauge<string>,

    @InjectMetric('task_controller_queue_utilization')
    private queueUtilization: Gauge<string>,
  ) {}

  /**
   * Record a reconcile cycle
   */
  recordReconcileCycle(durationMs: number): void {
    this.reconcileCyclesTotal.inc();
    this.reconcileDuration.observe(durationMs / 1000);
  }

  /**
   * Increment reconcile errors
   */
  incrementReconcileErrors(): void {
    this.reconcileErrorsTotal.inc();
  }

  /**
   * Increment TaskDesktops created
   */
  incrementTaskDesktopsCreated(): void {
    this.taskDesktopsCreatedTotal.inc();
  }

  /**
   * Increment pods claimed successfully (warm pool)
   */
  incrementPodsClaimedSuccessfully(): void {
    this.podsClaimedTotal.inc();
  }

  /**
   * v1.0.10: Increment overflow pods claimed successfully
   */
  incrementOverflowPodsClaimedSuccessfully(): void {
    this.overflowPodsClaimedTotal.inc();
  }

  /**
   * Increment pods claim failed
   */
  incrementPodsClaimFailed(): void {
    this.podsClaimFailedTotal.inc();
  }

  incrementDesktopPreflightFailed(): void {
    this.desktopPreflightFailedTotal.inc();
  }

  incrementOrphanDesktopClaimsCleared(count: number = 1): void {
    this.orphanDesktopClaimsClearedTotal.inc(count);
  }

  /**
   * Increment no warm pods available
   */
  incrementNoWarmPodsAvailable(): void {
    this.noWarmPodsTotal.inc();
  }

  /**
   * Increment tasks started
   */
  incrementTasksStarted(): void {
    this.tasksStartedTotal.inc();
  }

  /**
   * Increment tasks completed
   */
  incrementTasksCompleted(): void {
    this.tasksCompletedTotal.inc();
  }

  /**
   * Increment tasks failed
   */
  incrementTasksFailed(): void {
    this.tasksFailedTotal.inc();
  }

  /**
   * Increment tasks timed out
   */
  incrementTasksTimedOut(): void {
    this.tasksTimedOutTotal.inc();
  }

  /**
   * Set active TaskDesktops count
   */
  setActiveTaskDesktops(count: number): void {
    this.activeTaskDesktops.set(count);
  }

  /**
   * Set warm pods available count
   */
  setWarmPodsAvailable(count: number): void {
    this.warmPodsAvailable.set(count);
  }

  /**
   * Set leader status
   */
  setLeaderStatus(isLeaderNow: boolean): void {
    this.isLeader.set(isLeaderNow ? 1 : 0);
  }

  // ==========================================================================
  // v1.0.9: Metrics for overflow pool scaling (Phase 2)
  // ==========================================================================

  /**
   * Increment tasks that entered WaitingForCapacity phase
   * Called when a task transitions from Pending to WaitingForCapacity
   */
  incrementTasksWaitedForCapacity(): void {
    this.tasksWaitedForCapacityTotal.inc();
  }

  /**
   * Increment capacity wait timeout counter
   * Called when a task fails due to capacity wait timeout
   */
  incrementCapacityWaitTimeout(): void {
    this.capacityWaitTimeoutTotal.inc();
  }

  /**
   * Set number of tasks currently waiting for capacity
   * This is the primary metric for KEDA scaling triggers
   */
  setTasksWaitingForCapacity(count: number): void {
    this.tasksWaitingForCapacity.set(count);
  }

  /**
   * v1.0.11: Increment tasks waiting for capacity gauge
   * Called immediately when a task transitions TO WaitingForCapacity phase
   * This ensures KEDA sees the metric update without waiting for next reconcile cycle
   */
  incrementTasksWaitingForCapacityGauge(): void {
    this.tasksWaitingForCapacity.inc();
  }

  /**
   * v1.0.11: Decrement tasks waiting for capacity gauge
   * Called immediately when a task transitions FROM WaitingForCapacity phase
   * (either to Pending when capacity available, or to Failed on timeout)
   */
  decrementTasksWaitingForCapacityGauge(): void {
    this.tasksWaitingForCapacity.dec();
  }

  /**
   * Set total number of warm pool pods (available + assigned)
   */
  setWarmPodsTotal(count: number): void {
    this.warmPodsTotal.set(count);
  }

  // ==========================================================================
  // v1.0.10: Metrics for overflow pool (Phase 4)
  // ==========================================================================

  /**
   * v1.0.10: Set number of available overflow pool pods
   */
  setOverflowPodsAvailable(count: number): void {
    this.overflowPodsAvailable.set(count);
  }

  /**
   * v1.0.10: Set total number of overflow pool pods
   */
  setOverflowPodsTotal(count: number): void {
    this.overflowPodsTotal.set(count);
  }

  /**
   * Update all pool metrics at once
   * Called during each reconciliation cycle to keep metrics current
   * v1.0.10: Now includes overflow pool metrics
   */
  updatePoolMetrics(
    warmPodsAvailable: number,
    warmPodsTotal: number,
    tasksWaitingForCapacity: number,
    activeTaskDesktops: number,
    overflowPodsAvailable: number = 0,
    overflowPodsTotal: number = 0,
  ): void {
    this.warmPodsAvailable.set(warmPodsAvailable);
    this.warmPodsTotal.set(warmPodsTotal);
    this.tasksWaitingForCapacity.set(tasksWaitingForCapacity);
    this.activeTaskDesktops.set(activeTaskDesktops);
    // v1.0.10: Track overflow pool metrics
    this.overflowPodsAvailable.set(overflowPodsAvailable);
    this.overflowPodsTotal.set(overflowPodsTotal);
  }

  // ==========================================================================
  // v1.0.21: Phase 5 - Admission control and backpressure metrics
  // ==========================================================================

  /**
   * Increment tasks rejected counter
   * Called when a task is rejected due to backpressure (queue full)
   */
  incrementTasksRejected(): void {
    this.tasksRejectedTotal.inc();
  }

  /**
   * Increment admission queue full counter
   * Called when admission is denied due to max queue depth
   */
  incrementAdmissionQueueFull(): void {
    this.admissionQueueFullTotal.inc();
  }

  /**
   * Set the number of pending tasks in the queue
   */
  setPendingTasks(count: number): void {
    this.pendingTasks.set(count);
  }

  /**
   * Set queue utilization ratio (pending tasks / max queue depth)
   * Value between 0.0 and 1.0
   */
  setQueueUtilization(ratio: number): void {
    this.queueUtilization.set(ratio);
  }

  /**
   * Update admission control metrics
   * Called during each reconciliation cycle
   */
  updateAdmissionMetrics(pendingCount: number, maxQueueDepth: number): void {
    this.pendingTasks.set(pendingCount);
    const utilization = maxQueueDepth > 0 ? pendingCount / maxQueueDepth : 0;
    this.queueUtilization.set(Math.min(utilization, 1.0));
  }
}
