/**
 * Metrics Module
 * Prometheus metrics for workflow orchestrator
 *
 * Post-M5 Enhancement: Added approval flow metrics
 *
 * Metric Types:
 * - Counters: Total counts (approvals_total, webhooks_total)
 * - Gauges: Current values (approvals_pending)
 * - Histograms: Latency distributions (approval_latency_seconds)
 *
 * Best Practices Applied:
 * - Low cardinality labels (status, risk_level, tool_category)
 * - Meaningful bucket boundaries for histograms
 * - Clear metric naming (domain_metric_unit)
 */

import { Module, Global } from '@nestjs/common';
import { PrometheusModule, makeCounterProvider, makeGaugeProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [
    // =========================================================================
    // Workflow metrics
    // =========================================================================
    makeCounterProvider({
      name: 'workflow_runs_total',
      help: 'Total number of workflow runs',
      labelNames: ['status', 'tenant_id'],
    }),
    makeGaugeProvider({
      name: 'workflow_runs_active',
      help: 'Number of currently active workflow runs',
      labelNames: ['tenant_id'],
    }),
    makeHistogramProvider({
      name: 'workflow_duration_seconds',
      help: 'Workflow execution duration in seconds',
      labelNames: ['status'],
      buckets: [60, 300, 600, 1800, 3600, 7200],
    }),

    // =========================================================================
    // Node metrics
    // =========================================================================
    makeCounterProvider({
      name: 'workflow_nodes_total',
      help: 'Total number of workflow nodes executed',
      labelNames: ['type', 'status'],
    }),
    makeHistogramProvider({
      name: 'workflow_node_duration_seconds',
      help: 'Node execution duration in seconds',
      labelNames: ['type', 'status'],
      buckets: [1, 5, 10, 30, 60, 120, 300],
    }),

    // =========================================================================
    // Workspace metrics
    // =========================================================================
    makeGaugeProvider({
      name: 'workspaces_active',
      help: 'Number of active workspaces',
      labelNames: ['status'],
    }),
    makeCounterProvider({
      name: 'workspace_lock_acquisitions_total',
      help: 'Total workspace lock acquisition attempts',
      labelNames: ['success'],
    }),

    // =========================================================================
    // Scheduler metrics
    // =========================================================================
    makeGaugeProvider({
      name: 'scheduler_queue_depth',
      help: 'Number of nodes waiting to be scheduled',
    }),
    makeHistogramProvider({
      name: 'scheduler_loop_duration_seconds',
      help: 'Scheduler loop execution time',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    }),

    // =========================================================================
    // Post-M5: Approval flow metrics
    // =========================================================================

    // Counter: Total approval requests by status and risk level
    makeCounterProvider({
      name: 'approvals_total',
      help: 'Total number of approval requests',
      labelNames: ['status', 'risk_level', 'tool_category'],
    }),

    // Gauge: Currently pending approvals
    makeGaugeProvider({
      name: 'approvals_pending',
      help: 'Number of pending approval requests',
      labelNames: ['risk_level'],
    }),

    // Histogram: Time from request to decision (approval latency)
    makeHistogramProvider({
      name: 'approval_latency_seconds',
      help: 'Time from approval request to decision in seconds',
      labelNames: ['status', 'risk_level'],
      // Buckets: 1min, 5min, 15min, 30min, 1hr, 2hr, 6hr, 12hr, 24hr
      buckets: [60, 300, 900, 1800, 3600, 7200, 21600, 43200, 86400],
    }),

    // Counter: Expired approvals (subset of total, but useful for alerting)
    makeCounterProvider({
      name: 'approvals_expired_total',
      help: 'Total number of expired approval requests',
      labelNames: ['risk_level', 'tool_category'],
    }),

    // =========================================================================
    // Post-M5: Idempotency metrics
    // =========================================================================

    // Counter: Idempotency checks
    makeCounterProvider({
      name: 'idempotency_checks_total',
      help: 'Total idempotency checks performed',
      labelNames: ['result'], // 'new', 'cached', 'processing', 'failed'
    }),

    // Gauge: Active processing records
    makeGaugeProvider({
      name: 'idempotency_processing',
      help: 'Number of actions currently being processed',
    }),

    // Counter: Cache hits (returns cached result)
    makeCounterProvider({
      name: 'idempotency_cache_hits_total',
      help: 'Total cached results returned',
    }),

    // =========================================================================
    // Post-M5: Webhook notification metrics
    // =========================================================================

    // Counter: Webhook delivery attempts
    makeCounterProvider({
      name: 'webhooks_total',
      help: 'Total webhook delivery attempts',
      labelNames: ['event_type', 'success'],
    }),

    // Histogram: Webhook delivery latency
    makeHistogramProvider({
      name: 'webhook_delivery_seconds',
      help: 'Webhook delivery latency in seconds',
      labelNames: ['event_type'],
      // Buckets: 100ms, 500ms, 1s, 2s, 5s, 10s, 30s
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    }),

    // Counter: Webhook retries
    makeCounterProvider({
      name: 'webhook_retries_total',
      help: 'Total webhook retry attempts',
      labelNames: ['event_type'],
    }),

    // =========================================================================
    // Post-M5: Audit logging metrics
    // =========================================================================

    // Counter: Audit log entries created
    makeCounterProvider({
      name: 'audit_logs_total',
      help: 'Total audit log entries created',
      labelNames: ['event_type', 'resource_type'],
    }),

    // Counter: Audit logs cleaned up
    makeCounterProvider({
      name: 'audit_logs_cleaned_total',
      help: 'Total expired audit logs cleaned up',
    }),

    // =========================================================================
    // Post-M5: High-risk action metrics
    // =========================================================================

    // Counter: High-risk actions detected
    makeCounterProvider({
      name: 'high_risk_actions_total',
      help: 'Total high-risk actions detected',
      labelNames: ['tool_name', 'risk_level'],
    }),

    // Counter: High-risk actions by outcome
    makeCounterProvider({
      name: 'high_risk_outcomes_total',
      help: 'High-risk action outcomes',
      labelNames: ['outcome'], // 'approved', 'rejected', 'expired', 'executed'
    }),

    // =========================================================================
    // Phase 6: Goal Run metrics (Manus-style orchestration)
    // =========================================================================

    // Counter: Total goal runs by status
    makeCounterProvider({
      name: 'goal_runs_total',
      help: 'Total number of goal runs created',
      labelNames: ['status', 'tenant_id'],
    }),

    // Gauge: Currently active goal runs by phase
    makeGaugeProvider({
      name: 'goal_runs_active',
      help: 'Number of currently active goal runs',
      labelNames: ['phase', 'tenant_id'],
    }),

    // Histogram: Goal run total duration in seconds
    makeHistogramProvider({
      name: 'goal_run_duration_seconds',
      help: 'Total goal run duration from creation to completion',
      labelNames: ['status'],
      // Buckets: 1min, 5min, 15min, 30min, 1hr, 2hr, 4hr, 8hr
      buckets: [60, 300, 900, 1800, 3600, 7200, 14400, 28800],
    }),

    // Counter: Plan versions created (replanning events)
    makeCounterProvider({
      name: 'goal_run_replans_total',
      help: 'Total number of plan revisions (replanning events)',
      labelNames: ['tenant_id'],
    }),

    // Counter: Checklist items by status
    makeCounterProvider({
      name: 'checklist_items_total',
      help: 'Total checklist items processed',
      labelNames: ['status'], // PENDING, IN_PROGRESS, COMPLETED, FAILED, SKIPPED
    }),

    // Histogram: Individual checklist item execution duration
    makeHistogramProvider({
      name: 'checklist_item_duration_seconds',
      help: 'Individual checklist item execution duration',
      labelNames: ['status'],
      // Buckets: 10s, 30s, 1min, 2min, 5min, 10min, 30min
      buckets: [10, 30, 60, 120, 300, 600, 1800],
    }),

    // Counter: Steering messages received
    makeCounterProvider({
      name: 'steering_messages_total',
      help: 'Total steering messages received from users',
      labelNames: ['type'], // PAUSE, RESUME, CANCEL, MODIFY_PLAN, APPROVE, REJECT, INSTRUCTION
    }),

    // Counter: Activity events by type
    makeCounterProvider({
      name: 'activity_events_total',
      help: 'Total activity events recorded',
      labelNames: ['event_type', 'severity'],
    }),

    // =========================================================================
    // Capacity Hardening Metrics (v5.5.13)
    // =========================================================================

    // Gauge: Running workspace pods
    makeGaugeProvider({
      name: 'workspace_pods_running',
      help: 'Number of workspace pods currently running',
    }),

    // Gauge: Workspace capacity utilization (0.0-1.0)
    makeGaugeProvider({
      name: 'workspace_capacity_utilization_ratio',
      help: 'Workspace capacity utilization ratio (running/max)',
      labelNames: ['status'],  // 'normal', 'warning', 'critical'
    }),

    // Counter: Capacity exhaustion events
    makeCounterProvider({
      name: 'workspace_capacity_exhausted_total',
      help: 'Total times capacity was exhausted',
    }),

    // =========================================================================
    // Storage Hardening Metrics (v5.5.13)
    // =========================================================================

    // Gauge: Total workspace PVCs
    makeGaugeProvider({
      name: 'workspace_pvcs_total',
      help: 'Total number of workspace PVCs',
      labelNames: ['status'],  // 'active', 'hibernated', 'retained'
    }),

    // Gauge: Total PVC storage in bytes
    makeGaugeProvider({
      name: 'workspace_pvcs_storage_bytes',
      help: 'Total workspace PVC storage in bytes',
    }),

    // =========================================================================
    // Task Dispatch Reliability Metrics (v5.5.13)
    // =========================================================================

    // Counter: Task dispatch errors by type
    makeCounterProvider({
      name: 'task_dispatch_errors_total',
      help: 'Total task dispatch errors',
      labelNames: ['error_type'],  // '404', 'timeout', 'network', 'infra', 'semantic'
    }),

    // Counter: Infrastructure retries
    makeCounterProvider({
      name: 'task_dispatch_infra_retries_total',
      help: 'Total infrastructure retry attempts',
    }),

    // Histogram: Task dispatch latency
    makeHistogramProvider({
      name: 'task_dispatch_latency_seconds',
      help: 'Task dispatch API call latency',
      labelNames: ['operation'],  // 'dispatch', 'status_check', 'cancel'
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    }),

    // =========================================================================
    // Garbage Collection Metrics (v5.5.13)
    // =========================================================================

    // Counter: Workspaces hibernated by GC
    makeCounterProvider({
      name: 'workspace_gc_hibernated_total',
      help: 'Total workspaces hibernated by GC',
      labelNames: ['reason'],  // 'orphan', 'completed', 'idle', 'retry'
    }),

    // Gauge: Idle workspaces pending hibernation
    makeGaugeProvider({
      name: 'workspace_gc_idle_pending',
      help: 'Number of idle workspaces pending hibernation',
    }),

    // Counter: GC cycle runs
    makeCounterProvider({
      name: 'workspace_gc_cycles_total',
      help: 'Total GC cycles executed',
      labelNames: ['result'],  // 'success', 'partial', 'failed'
    }),

    // =========================================================================
    // Database Metrics (v5.5.13)
    // =========================================================================

    // Histogram: Orchestrator DB query latency
    makeHistogramProvider({
      name: 'orchestrator_db_query_duration_seconds',
      help: 'Orchestrator database query duration',
      labelNames: ['operation'],  // 'goal_run_read', 'checklist_update', 'workspace_read'
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    }),

    // =========================================================================
    // Outbox + User Prompt Ops Metrics (PR 3)
    // =========================================================================

    makeGaugeProvider({
      name: 'outbox_pending_total',
      help: 'Number of pending outbox rows (processed_at IS NULL)',
      labelNames: ['event_type'],
    }),
    makeGaugeProvider({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age in seconds of the oldest pending outbox row',
    }),
    makeCounterProvider({
      name: 'outbox_publish_attempts_total',
      help: 'Outbox publish attempts (success/failure)',
      labelNames: ['event_type', 'result'],
    }),

    makeGaugeProvider({
      name: 'user_prompts_open_total',
      help: 'Number of OPEN user prompts',
      labelNames: ['kind'],
    }),
    makeHistogramProvider({
      name: 'user_prompt_time_to_resolve_seconds',
      help: 'Time from prompt creation to resolution in seconds',
      labelNames: ['kind'],
      buckets: [30, 60, 300, 900, 1800, 3600, 7200, 21600, 86400],
    }),

    // =========================================================================
    // Stark Interaction SLIs (P1)
    // =========================================================================

    // Counter: Goal intake started (gate vs planner safety-net)
    makeCounterProvider({
      name: 'goal_intake_started_total',
      help: 'Total number of goal intake gates triggered',
      labelNames: ['source'], // 'gate' | 'planner_error'
    }),

    // Counter: Goal intake completed (GoalSpec marked COMPLETE)
    makeCounterProvider({
      name: 'goal_intake_completed_total',
      help: 'Total number of goal intake completions',
    }),

    // Counter: Prompt resolutions by actor + kind
    makeCounterProvider({
      name: 'prompt_resolved_total',
      help: 'Total prompt resolutions by actorType and kind',
      labelNames: ['actor_type', 'kind'],
    }),

    // Counter: Prompt resolution failures (fail-closed)
    makeCounterProvider({
      name: 'user_prompt_resolution_validation_fail_total',
      help: 'Total prompt resolution attempts rejected by JSON schema validation',
      labelNames: ['kind', 'scope'],
    }),
    makeCounterProvider({
      name: 'user_prompt_resolution_unauthorized_total',
      help: 'Total prompt resolution attempts rejected by authorization policy',
      labelNames: ['kind', 'actor_type'],
    }),
    makeCounterProvider({
      name: 'user_prompt_resolution_incomplete_after_apply_total',
      help: 'Total prompt resolution attempts where answers applied but derived completeness still failed',
      labelNames: ['kind'],
    }),

    // Counter: Resume outbox enqueued (resolution vs reconciler repair)
    makeCounterProvider({
      name: 'resume_outbox_enqueued_total',
      help: 'Total resume outbox events enqueued',
      labelNames: ['source'], // 'resolution' | 'reconciler'
    }),

    // Counter: Temporal resume Update outcomes (idempotent by updateId)
    makeCounterProvider({
      name: 'resume_update_success_total',
      help: 'Total successful Temporal resume Updates',
    }),
    makeCounterProvider({
      name: 'resume_update_failed_total',
      help: 'Total failed Temporal resume Updates',
    }),

    // Gauge: Runs stuck in WAITING_USER_INPUT by age bucket
    makeGaugeProvider({
      name: 'runs_stuck_waiting_user_input_total',
      help: 'Number of goal runs in WAITING_USER_INPUT by age bucket',
      labelNames: ['age_bucket'], // 'lt_5m' | '5m_15m' | '15m_1h' | '1h_24h' | 'gt_24h'
    }),

    // Gauge: RESOLVED prompts without durable resume acknowledgement
    makeGaugeProvider({
      name: 'prompts_resolved_without_resume_ack_total',
      help: 'Number of resolved prompts missing resume_acknowledged_at',
    }),

    // =========================================================================
    // Temporal Rollout Guardrails (Capability Probe)
    // =========================================================================

    makeGaugeProvider({
      name: 'temporal_capability_probe_ok',
      help: '1 if orchestrator can reach Temporal service APIs; 0 otherwise',
    }),
    makeCounterProvider({
      name: 'temporal_capability_probe_failures_total',
      help: 'Total Temporal capability probe failures',
    }),
  ],
  exports: [
    PrometheusModule,
    // Export metric providers used via `@InjectMetric(...)`
    'PROM_METRIC_OUTBOX_PENDING_TOTAL',
    'PROM_METRIC_OUTBOX_OLDEST_PENDING_AGE_SECONDS',
    'PROM_METRIC_OUTBOX_PUBLISH_ATTEMPTS_TOTAL',
    'PROM_METRIC_USER_PROMPTS_OPEN_TOTAL',
    'PROM_METRIC_USER_PROMPT_TIME_TO_RESOLVE_SECONDS',

    'PROM_METRIC_GOAL_INTAKE_STARTED_TOTAL',
    'PROM_METRIC_GOAL_INTAKE_COMPLETED_TOTAL',
    'PROM_METRIC_PROMPT_RESOLVED_TOTAL',
    'PROM_METRIC_USER_PROMPT_RESOLUTION_VALIDATION_FAIL_TOTAL',
    'PROM_METRIC_USER_PROMPT_RESOLUTION_UNAUTHORIZED_TOTAL',
    'PROM_METRIC_USER_PROMPT_RESOLUTION_INCOMPLETE_AFTER_APPLY_TOTAL',
    'PROM_METRIC_RESUME_OUTBOX_ENQUEUED_TOTAL',
    'PROM_METRIC_RESUME_UPDATE_SUCCESS_TOTAL',
    'PROM_METRIC_RESUME_UPDATE_FAILED_TOTAL',
    'PROM_METRIC_RUNS_STUCK_WAITING_USER_INPUT_TOTAL',
    'PROM_METRIC_PROMPTS_RESOLVED_WITHOUT_RESUME_ACK_TOTAL',

    'PROM_METRIC_TEMPORAL_CAPABILITY_PROBE_OK',
    'PROM_METRIC_TEMPORAL_CAPABILITY_PROBE_FAILURES_TOTAL',
  ],
})
export class MetricsModule {}
