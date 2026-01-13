/**
 * Metrics Module
 * Configures Prometheus metrics
 */

import { Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsService } from '../services/metrics.service';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [
    MetricsService,

    // Counters
    makeCounterProvider({
      name: 'task_controller_reconcile_cycles_total',
      help: 'Total number of reconciliation cycles',
    }),
    makeCounterProvider({
      name: 'task_controller_reconcile_errors_total',
      help: 'Total number of reconciliation errors',
    }),
    makeCounterProvider({
      name: 'task_controller_taskdesktops_created_total',
      help: 'Total number of TaskDesktop resources created',
    }),
    makeCounterProvider({
      name: 'task_controller_pods_claimed_total',
      help: 'Total number of warm pool pods claimed successfully',
    }),
    // v1.0.10: Track overflow pool claims separately
    makeCounterProvider({
      name: 'task_controller_overflow_pods_claimed_total',
      help: 'Total number of overflow pool pods claimed successfully',
    }),
    makeCounterProvider({
      name: 'task_controller_pods_claim_failed_total',
      help: 'Total number of failed pod claim attempts',
    }),
    makeCounterProvider({
      name: 'task_controller_desktop_preflight_failed_total',
      help: 'Total number of times a claimed desktop failed allocator preflight',
    }),
    makeCounterProvider({
      name: 'task_controller_orphan_desktop_claims_cleared_total',
      help: 'Total number of orphan desktop claims cleared (assigned pods without valid TaskDesktop owner)',
    }),
    makeCounterProvider({
      name: 'task_controller_no_warm_pods_total',
      help: 'Total number of times no warm pods were available',
    }),
    makeCounterProvider({
      name: 'task_controller_tasks_started_total',
      help: 'Total number of tasks started',
    }),
    makeCounterProvider({
      name: 'task_controller_tasks_completed_total',
      help: 'Total number of tasks completed',
    }),
    makeCounterProvider({
      name: 'task_controller_tasks_failed_total',
      help: 'Total number of tasks failed',
    }),
    makeCounterProvider({
      name: 'task_controller_tasks_timed_out_total',
      help: 'Total number of tasks that timed out',
    }),
    // v1.0.9: Metrics for overflow pool scaling (Phase 2)
    makeCounterProvider({
      name: 'task_controller_tasks_waited_for_capacity_total',
      help: 'Total number of tasks that entered WaitingForCapacity phase',
    }),
    makeCounterProvider({
      name: 'task_controller_capacity_wait_timeout_total',
      help: 'Total number of tasks that failed due to capacity wait timeout',
    }),
    // v1.0.21: Phase 5 - Admission control and backpressure metrics
    makeCounterProvider({
      name: 'task_controller_tasks_rejected_total',
      help: 'Total number of tasks rejected due to backpressure',
    }),
    makeCounterProvider({
      name: 'task_controller_admission_queue_full_total',
      help: 'Total number of times admission was denied due to queue depth limit',
    }),

    // Gauges
    makeGaugeProvider({
      name: 'task_controller_active_taskdesktops',
      help: 'Number of active TaskDesktop resources',
    }),
    makeGaugeProvider({
      name: 'task_controller_warm_pods_available',
      help: 'Number of warm pods available for claiming',
    }),
    // v1.0.9: Metrics for overflow pool scaling (Phase 2)
    makeGaugeProvider({
      name: 'task_controller_tasks_waiting_for_capacity',
      help: 'Number of tasks currently waiting for capacity (triggers KEDA scaling)',
    }),
    makeGaugeProvider({
      name: 'task_controller_warm_pods_total',
      help: 'Total number of warm pool pods (available + assigned)',
    }),
    // v1.0.10: Overflow pool metrics
    makeGaugeProvider({
      name: 'task_controller_overflow_pods_available',
      help: 'Number of overflow pods available for claiming',
    }),
    makeGaugeProvider({
      name: 'task_controller_overflow_pods_total',
      help: 'Total number of overflow pool pods (available + assigned)',
    }),
    makeGaugeProvider({
      name: 'task_controller_is_leader',
      help: 'Whether this instance is the leader (1) or not (0)',
    }),
    // v1.0.21: Phase 5 - Admission control metrics
    makeGaugeProvider({
      name: 'task_controller_pending_tasks',
      help: 'Number of tasks pending in database queue',
    }),
    makeGaugeProvider({
      name: 'task_controller_queue_utilization',
      help: 'Ratio of pending tasks to max queue depth (0.0 to 1.0)',
    }),

    // Histograms
    makeHistogramProvider({
      name: 'task_controller_reconcile_duration_seconds',
      help: 'Duration of reconciliation cycles in seconds',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
