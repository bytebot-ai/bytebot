/**
 * Metrics Service - Phase 10.1: Enhanced Observability
 *
 * Provides a clean API for recording business metrics from workflows and activities.
 * Follows best practices for Prometheus metrics collection:
 * - Thread-safe counter/histogram updates
 * - Consistent label values
 * - Timer utilities for measuring durations
 */

import { Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter, Histogram, Gauge } from 'prom-client';

// ============================================================================
// Types
// ============================================================================

export type WorkflowStatus = 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'completed' | 'failed' | 'skipped' | 'retried';
// Phase 11: Extended ActivityType to include new activity types and circuit breaker patterns
export type ActivityType =
  | 'planning'
  | 'execution'
  | 'verification'
  | 'kafka'
  | 'refinement'
  | 'fallback_planning'
  | `circuit_${string}`; // Dynamic circuit breaker activity types
export type ActivityStatus = 'success' | 'failure' | 'timeout' | 'fallback';
export type LLMStatus = 'success' | 'error' | 'timeout';
export type ReplanReason = 'step_failed' | 'verification_failed' | 'steering' | 'manual';
export type WorkflowPhase = 'planning' | 'executing' | 'verifying' | 'paused' | 'waiting_approval';
export type HITLEventType = 'approval_requested' | 'approved' | 'rejected' | 'timeout';
export type ApprovalResult = 'approved' | 'rejected' | 'timeout';

// ============================================================================
// Metrics Service
// ============================================================================

@Injectable()
export class MetricsService {
  constructor(
    @InjectMetric('bytebot_workflow_executions_total')
    private readonly workflowExecutions: Counter<string>,

    @InjectMetric('bytebot_workflow_duration_seconds')
    private readonly workflowDuration: Histogram<string>,

    @InjectMetric('bytebot_step_executions_total')
    private readonly stepExecutions: Counter<string>,

    @InjectMetric('bytebot_step_duration_seconds')
    private readonly stepDuration: Histogram<string>,

    @InjectMetric('bytebot_activity_executions_total')
    private readonly activityExecutions: Counter<string>,

    @InjectMetric('bytebot_activity_duration_seconds')
    private readonly activityDuration: Histogram<string>,

    @InjectMetric('bytebot_llm_calls_total')
    private readonly llmCalls: Counter<string>,

    @InjectMetric('bytebot_llm_latency_seconds')
    private readonly llmLatency: Histogram<string>,

    @InjectMetric('bytebot_replan_events_total')
    private readonly replanEvents: Counter<string>,

    @InjectMetric('bytebot_active_workflows')
    private readonly activeWorkflows: Gauge<string>,

    @InjectMetric('bytebot_hitl_events_total')
    private readonly hitlEvents: Counter<string>,

    @InjectMetric('bytebot_approval_wait_seconds')
    private readonly approvalWait: Histogram<string>,

    @InjectMetric('bytebot_errors_total')
    private readonly errorEvents: Counter<string>,
  ) {}

  // ==========================================================================
  // Workflow Metrics
  // ==========================================================================

  /**
   * Record a completed workflow execution
   */
  recordWorkflowExecution(status: WorkflowStatus, tenantId: string): void {
    this.workflowExecutions.inc({ status, tenant_id: tenantId });
  }

  /**
   * Record workflow duration
   */
  recordWorkflowDuration(durationMs: number, status: WorkflowStatus, tenantId: string): void {
    this.workflowDuration.observe(
      { status, tenant_id: tenantId },
      durationMs / 1000
    );
  }

  /**
   * Start timing a workflow (returns end timer function)
   */
  startWorkflowTimer(status: WorkflowStatus, tenantId: string): () => number {
    return this.workflowDuration.startTimer({ status, tenant_id: tenantId });
  }

  /**
   * Update active workflows count
   */
  setActiveWorkflows(phase: WorkflowPhase, count: number): void {
    this.activeWorkflows.set({ phase }, count);
  }

  incrementActiveWorkflows(phase: WorkflowPhase): void {
    this.activeWorkflows.inc({ phase });
  }

  decrementActiveWorkflows(phase: WorkflowPhase): void {
    this.activeWorkflows.dec({ phase });
  }

  // ==========================================================================
  // Step Metrics
  // ==========================================================================

  /**
   * Record a step execution
   */
  recordStepExecution(status: StepStatus, isHighRisk: boolean): void {
    this.stepExecutions.inc({
      status,
      high_risk: isHighRisk ? 'true' : 'false',
    });
  }

  /**
   * Record step duration
   */
  recordStepDuration(durationMs: number, status: StepStatus): void {
    this.stepDuration.observe({ status }, durationMs / 1000);
  }

  /**
   * Start timing a step execution
   */
  startStepTimer(status: StepStatus): () => number {
    return this.stepDuration.startTimer({ status });
  }

  // ==========================================================================
  // Activity Metrics
  // ==========================================================================

  /**
   * Record an activity execution
   */
  recordActivityExecution(activityType: ActivityType, status: ActivityStatus): void {
    this.activityExecutions.inc({ activity_type: activityType, status });
  }

  /**
   * Record activity duration
   */
  recordActivityDuration(activityType: ActivityType, durationMs: number): void {
    this.activityDuration.observe({ activity_type: activityType }, durationMs / 1000);
  }

  /**
   * Start timing an activity execution
   */
  startActivityTimer(activityType: ActivityType): () => number {
    return this.activityDuration.startTimer({ activity_type: activityType });
  }

  /**
   * Convenience method to time and record an activity
   */
  async timeActivity<T>(
    activityType: ActivityType,
    fn: () => Promise<T>
  ): Promise<T> {
    const endTimer = this.startActivityTimer(activityType);
    try {
      const result = await fn();
      endTimer();
      this.recordActivityExecution(activityType, 'success');
      return result;
    } catch (error) {
      endTimer();
      const status = this.isTimeoutError(error) ? 'timeout' : 'failure';
      this.recordActivityExecution(activityType, status);
      throw error;
    }
  }

  // ==========================================================================
  // LLM Metrics
  // ==========================================================================

  /**
   * Record an LLM API call
   */
  recordLLMCall(model: string, status: LLMStatus): void {
    this.llmCalls.inc({ model, status });
  }

  /**
   * Record LLM latency
   */
  recordLLMLatency(model: string, durationMs: number): void {
    this.llmLatency.observe({ model }, durationMs / 1000);
  }

  /**
   * Start timing an LLM call
   */
  startLLMTimer(model: string): () => number {
    return this.llmLatency.startTimer({ model });
  }

  /**
   * Convenience method to time and record an LLM call
   */
  async timeLLMCall<T>(model: string, fn: () => Promise<T>): Promise<T> {
    const endTimer = this.startLLMTimer(model);
    try {
      const result = await fn();
      endTimer();
      this.recordLLMCall(model, 'success');
      return result;
    } catch (error) {
      endTimer();
      const status = this.isTimeoutError(error) ? 'timeout' : 'error';
      this.recordLLMCall(model, status);
      throw error;
    }
  }

  // ==========================================================================
  // Replan Metrics
  // ==========================================================================

  /**
   * Record a replanning event
   */
  recordReplanEvent(reason: ReplanReason): void {
    this.replanEvents.inc({ reason });
  }

  // ==========================================================================
  // Human-in-the-Loop Metrics
  // ==========================================================================

  /**
   * Record a HITL event
   */
  recordHITLEvent(eventType: HITLEventType): void {
    this.hitlEvents.inc({ event_type: eventType });
  }

  /**
   * Record approval wait time
   */
  recordApprovalWait(durationMs: number, result: ApprovalResult): void {
    this.approvalWait.observe({ result }, durationMs / 1000);
  }

  // ==========================================================================
  // Error Metrics
  // ==========================================================================

  /**
   * Record an error event
   */
  recordError(errorType: string, recoverable: boolean): void {
    this.errorEvents.inc({
      error_type: this.normalizeErrorType(errorType),
      recoverable: recoverable ? 'true' : 'false',
    });
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private isTimeoutError(error: unknown): boolean {
    if (error instanceof Error) {
      return (
        error.message.includes('timeout') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('ESOCKETTIMEDOUT')
      );
    }
    return false;
  }

  private normalizeErrorType(errorType: string): string {
    // Normalize error types to prevent cardinality explosion
    const normalized = errorType
      .toUpperCase()
      .replace(/[^A-Z_]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 50); // Limit length
    return normalized || 'UNKNOWN';
  }
}

// ============================================================================
// Singleton instance for use in activities (non-DI context)
// ============================================================================

let metricsServiceInstance: MetricsService | null = null;

export function setMetricsServiceInstance(service: MetricsService): void {
  metricsServiceInstance = service;
}

export function getMetricsService(): MetricsService | null {
  return metricsServiceInstance;
}
