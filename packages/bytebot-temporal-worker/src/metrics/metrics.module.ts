/**
 * Metrics Module - Phase 10.1: Enhanced Observability
 *
 * Provides custom Prometheus metrics for ByteBot Temporal Worker:
 * - Workflow execution counts and durations
 * - Step execution timing histograms
 * - Activity performance metrics
 * - Error rates by type
 * - LLM call latencies
 *
 * Best Practices (Temporal 2025-2026):
 * - Use labels sparingly to avoid cardinality explosion
 * - Prefer histograms over summaries for aggregatable percentiles
 * - Export business metrics alongside Temporal SDK metrics
 */

import { Module, Global } from '@nestjs/common';
import { PrometheusModule, makeCounterProvider, makeHistogramProvider, makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';

// ============================================================================
// Metric Definitions
// ============================================================================

/**
 * Counter: Total number of workflow executions
 * Labels: status (completed, failed, cancelled), tenant_id
 */
const workflowExecutionsCounter = makeCounterProvider({
  name: 'bytebot_workflow_executions_total',
  help: 'Total number of workflow executions',
  labelNames: ['status', 'tenant_id'],
});

/**
 * Histogram: Workflow execution duration in seconds
 * Labels: status, tenant_id
 */
const workflowDurationHistogram = makeHistogramProvider({
  name: 'bytebot_workflow_duration_seconds',
  help: 'Workflow execution duration in seconds',
  labelNames: ['status', 'tenant_id'],
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
});

/**
 * Counter: Total number of step executions
 * Labels: status (completed, failed, skipped, retried), high_risk
 */
const stepExecutionsCounter = makeCounterProvider({
  name: 'bytebot_step_executions_total',
  help: 'Total number of step executions',
  labelNames: ['status', 'high_risk'],
});

/**
 * Histogram: Step execution duration in seconds
 * Labels: status
 */
const stepDurationHistogram = makeHistogramProvider({
  name: 'bytebot_step_duration_seconds',
  help: 'Step execution duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
});

/**
 * Counter: Total number of activity executions
 * Labels: activity_type (planning, execution, verification, kafka), status
 */
const activityExecutionsCounter = makeCounterProvider({
  name: 'bytebot_activity_executions_total',
  help: 'Total number of activity executions',
  labelNames: ['activity_type', 'status'],
});

/**
 * Histogram: Activity execution duration in seconds
 * Labels: activity_type
 */
const activityDurationHistogram = makeHistogramProvider({
  name: 'bytebot_activity_duration_seconds',
  help: 'Activity execution duration in seconds',
  labelNames: ['activity_type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
});

/**
 * Counter: Total LLM API calls
 * Labels: model, status (success, error, timeout)
 */
const llmCallsCounter = makeCounterProvider({
  name: 'bytebot_llm_calls_total',
  help: 'Total number of LLM API calls',
  labelNames: ['model', 'status'],
});

/**
 * Histogram: LLM API call latency in seconds
 * Labels: model
 */
const llmLatencyHistogram = makeHistogramProvider({
  name: 'bytebot_llm_latency_seconds',
  help: 'LLM API call latency in seconds',
  labelNames: ['model'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 90, 120],
});

/**
 * Counter: Total replanning events
 * Labels: reason (step_failed, verification_failed, steering)
 */
const replanEventsCounter = makeCounterProvider({
  name: 'bytebot_replan_events_total',
  help: 'Total number of replanning events',
  labelNames: ['reason'],
});

/**
 * Gauge: Current active workflows
 * Labels: phase (planning, executing, verifying, paused)
 */
const activeWorkflowsGauge = makeGaugeProvider({
  name: 'bytebot_active_workflows',
  help: 'Number of currently active workflows',
  labelNames: ['phase'],
});

/**
 * Counter: Human-in-the-loop events
 * Labels: event_type (approval_requested, approved, rejected)
 */
const hitlEventsCounter = makeCounterProvider({
  name: 'bytebot_hitl_events_total',
  help: 'Human-in-the-loop events',
  labelNames: ['event_type'],
});

/**
 * Histogram: Approval wait time in seconds
 * Labels: result (approved, rejected, timeout)
 */
const approvalWaitHistogram = makeHistogramProvider({
  name: 'bytebot_approval_wait_seconds',
  help: 'Time waiting for human approval in seconds',
  labelNames: ['result'],
  buckets: [10, 30, 60, 300, 600, 1800, 3600, 7200, 14400, 28800],
});

/**
 * Counter: Error events by type
 * Labels: error_type, recoverable
 */
const errorEventsCounter = makeCounterProvider({
  name: 'bytebot_errors_total',
  help: 'Total error events',
  labelNames: ['error_type', 'recoverable'],
});

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      defaultMetrics: {
        enabled: true,
        config: {
          prefix: 'bytebot_',
        },
      },
      path: '/metrics',
    }),
  ],
  providers: [
    MetricsService,
    workflowExecutionsCounter,
    workflowDurationHistogram,
    stepExecutionsCounter,
    stepDurationHistogram,
    activityExecutionsCounter,
    activityDurationHistogram,
    llmCallsCounter,
    llmLatencyHistogram,
    replanEventsCounter,
    activeWorkflowsGauge,
    hitlEventsCounter,
    approvalWaitHistogram,
    errorEventsCounter,
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
