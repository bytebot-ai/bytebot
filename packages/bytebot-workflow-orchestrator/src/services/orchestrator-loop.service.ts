/**
 * Orchestrator Loop Service
 * v2.3.0: Non-blocking startup for Kubernetes probe success (CRITICAL FIX)
 *         - Defers resumeActiveGoalRuns() until after HTTP server binds
 *         - Uses setImmediate() pattern for event loop deferral
 *         - Fixes pod crash loop when initializing with running goal runs
 * v2.2.0: Context-Preserving Replanning (Industry Standard Fix)
 *         - Manus-style checkpoint service integration
 *         - Updates checkpoint after each step completion
 *         - Enables recovery from any point without re-running successful steps
 * v2.1.0: Option C Industry Standard Fix - Heartbeat timeout uses RETRY not REPLAN
 *         - Google-style failure classification (transient vs semantic)
 *         - Separate retry budgets for heartbeat (5) vs replan (3)
 *         - Manus-style error preservation for diagnostics
 *         - Fixes: Heartbeat gaps no longer exhaust replan budget
 * v2.0.0: Phase E maintenance mode handling - graceful drain and recovery
 * v1.9.0: Phase D UX improvements - delay notifications for user awareness
 * v1.8.0: Phase C heartbeat-based timeout (replaces static TTL)
 * v1.7.0: DB transient error resilience - graceful handling of DB restarts
 * v1.6.0: Configurable loop interval (LOOP_INTERVAL_MS env var, default 5000ms)
 * v1.5.0: DB-driven retry gating to prevent tight loop bug (CPU/DB thrashing)
 * v1.1.1: Infrastructure failure retry (don't consume replan budget on infra issues)
 * v1.1.0: Fixed runaway workspace creation bug with link-first pattern
 * v1.0.1: Fixed race condition in planning phase with atomic phase transitions
 * v1.0.0: Core PEVR (Plan-Execute-Verify-Replan) loop for Manus-style orchestration
 *
 * Responsibilities:
 * - Run the main orchestration loop for goal runs
 * - Coordinate between planner, executor, and verifier
 * - Handle steering messages and user interventions
 * - Manage phase transitions
 *
 * DB Transient Resilience (v1.7.0):
 * - Wraps loop tick in DbTransientService.withTransientGuard()
 * - Transient DB errors trigger backoff (5s→60s), not crash
 * - Throttled logging (once per backoff window)
 * - Activity events throttled (once per minute max)
 * - Timeout/replan evaluation gated by DB availability
 *
 * Runaway Loop Fix (v1.1.0):
 * - createWorkflowForGoalRun: LINK FIRST, provision second
 * - Creates workflow record and links to goalRun BEFORE attempting desktop provisioning
 * - Prevents infinite workspace creation when provisioning fails
 * - Handles capacity issues with exponential backoff, not replanning
 *
 * @see Phase 2 fix: https://book.kubebuilder.io/reference/good-practices
 * @see Backoff pattern: https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html
 *
 * Race Condition Fix (v1.0.1):
 * - makeDecision: Only triggers PLAN for INITIALIZING phase, not PLANNING
 * - executePlanningPhase: Uses atomic updateMany with conditional WHERE to
 *   ensure only one iteration can start planning (optimistic locking pattern)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { GoalRunService, GoalRunPhase, GoalRunStatus } from './goal-run.service';
import { PlannerService } from './planner.service';
import { PlannerFirstStepUserInputError } from './planner.errors';
import { GoalIntakeService } from './goal-intake.service';
import { hasUserInteractionTool } from '../contracts/planner-tools';
import { WorkflowService, WorkflowStatus, NodeStatus, WorkspaceProvisioningStatus } from './workflow.service';
import { TaskDispatchService } from './task-dispatch.service';
import { DbTransientService } from './db-transient.service';
import { MaintenanceModeService, MaintenanceState } from './maintenance-mode.service';
import { FailureClassificationService, FailureCategory } from './failure-classification.service';
import { GoalCheckpointService } from './goal-checkpoint.service';
import { ChecklistItemStatus, ExecutionSurface, StepType, UserPromptKind } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { UserPromptService } from './user-prompt.service';
import { OutboxService } from './outbox.service';

// Loop configuration
// v1.6.0: Changed default from 1000ms to 5000ms - reduces DB load ~80% with no UX regression
// TaskDispatchService already polls every 5s, so faster orchestrator polling provides no benefit
const DEFAULT_LOOP_INTERVAL_MS = 5000;
const MAX_REPLAN_ATTEMPTS = 3;

// v1.8.0 Phase C: Heartbeat-based timeout replaces static TTL
// - Primary: Heartbeat health from TaskDispatchService (dynamic, agent-driven)
// - Fallback: MAX_STEP_TTL_MS as absolute safeguard (static, time-based)
// The old STEP_TIMEOUT_MS (5 min) is replaced by heartbeat-based detection
const MAX_STEP_TTL_MS = 30 * 60 * 1000; // 30 minutes absolute maximum per step (safeguard)

// v1.1.1: Infrastructure failure retry configuration
// Infrastructure failures (404, timeout, network) should retry, not replan
const MAX_INFRA_RETRIES = 5; // Max retries for infrastructure failures per step
const INFRA_RETRY_BASE_DELAY_MS = 10000; // 10 seconds base delay, doubles each retry (exponential backoff)

// v1.7.0: Restart grace window configuration
// After orchestrator restart, don't apply timeout/replan logic until state is reconciled
// This prevents the "immediate replan on restart" bug where in-progress steps are
// incorrectly marked as timed out because they appear to have been running for
// the entire duration since the pod last polled (before crash/restart).
const DEFAULT_RESTART_GRACE_MS = 5 * 60 * 1000; // 5 minutes grace window

// v1.9.0 Phase D: Delay notification thresholds (UX improvements)
// Notify users when steps are taking longer than expected
const DELAY_WARNING_THRESHOLD_MS = 60 * 1000;      // Warn after 1 minute
const DELAY_CRITICAL_THRESHOLD_MS = 3 * 60 * 1000; // Critical after 3 minutes
const DELAY_NOTIFICATION_INTERVAL_MS = 60 * 1000;  // Don't spam - notify once per minute

// Loop decision types
type LoopAction =
  | 'PLAN'
  | 'EXECUTE'
  | 'VERIFY'
  | 'REPLAN'
  | 'RETRY'  // v1.1.1: Retry same step (for infrastructure failures)
  | 'WAIT_APPROVAL'
  | 'COMPLETE'
  | 'FAIL'
  | 'PAUSE'
  | 'CONTINUE';

interface LoopDecision {
  action: LoopAction;
  itemId?: string;
  nodeRunId?: string;
  reason?: string;
  retryCount?: number;  // v1.1.1: Infrastructure retry count
  retryDelayMs?: number;  // v1.1.1: Delay before retry (exponential backoff)
}

interface ActiveLoop {
  goalRunId: string;
  intervalId: NodeJS.Timeout;
  isRunning: boolean;
}

@Injectable()
export class OrchestratorLoopService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorLoopService.name);
  private readonly activeLoops = new Map<string, ActiveLoop>();
  private readonly replanCounts = new Map<string, number>();
  // v1.1.1: Track infrastructure retry counts per checklist item
  // Key: checklistItemId, Value: retry count
  private readonly infraRetryCounts = new Map<string, number>();
  // v1.1.1: Track next eligible retry time per checklist item (exponential backoff)
  // Key: checklistItemId, Value: timestamp when retry is allowed
  private readonly infraRetryAfter = new Map<string, number>();
  // v1.6.0: Configurable loop interval from env var
  private readonly loopIntervalMs: number;
  // v1.7.0: Restart grace window - don't timeout/replan during grace
  private readonly restartGraceMs: number;
  private readonly processStartAt: number;
  // v1.7.0: Track which goal runs have been reconciled after restart
  private readonly reconciledGoalRuns = new Set<string>();
  // v1.9.0 Phase D: Track last delay notification time per checklist item
  // Key: checklistItemId, Value: { lastNotifiedAt: timestamp, severity: 'warning' | 'critical' }
  private readonly delayNotifications = new Map<string, { lastNotifiedAt: number; severity: string }>();

  constructor(
    private prisma: PrismaService,
    private goalRunService: GoalRunService,
    private plannerService: PlannerService,
    private goalIntakeService: GoalIntakeService,
    private workflowService: WorkflowService,
    private taskDispatchService: TaskDispatchService,
    private dbTransientService: DbTransientService,
    private maintenanceModeService: MaintenanceModeService,
    private failureClassificationService: FailureClassificationService,
    private goalCheckpointService: GoalCheckpointService, // v2.2.0: Manus-style checkpoint
    private eventEmitter: EventEmitter2,
    private configService: ConfigService,
    private userPromptService: UserPromptService,
    private outboxService: OutboxService,
  ) {
    // v1.6.0: Read loop interval from env var, default to 5000ms
    this.loopIntervalMs = parseInt(
      this.configService.get<string>('LOOP_INTERVAL_MS', String(DEFAULT_LOOP_INTERVAL_MS)),
      10,
    );
    // v1.7.0: Restart grace window - record process start time
    this.processStartAt = Date.now();
    this.restartGraceMs = parseInt(
      this.configService.get<string>('ORCHESTRATOR_RESTART_GRACE_MS', String(DEFAULT_RESTART_GRACE_MS)),
      10,
    );
  }

  /**
   * v5.11.2: Non-blocking initialization to allow HTTP server to start first
   *
   * CRITICAL FIX: The previous implementation used `await this.resumeActiveGoalRuns()`
   * which blocked NestJS startup, preventing the HTTP server from binding to port 8080.
   * This caused Kubernetes liveness probes to fail and pods to crash.
   *
   * Solution: Use setImmediate() to defer heavy initialization to the next event loop tick.
   * This allows:
   * 1. NestJS module initialization to complete synchronously
   * 2. app.listen() to bind HTTP server to port 8080
   * 3. Health endpoints to respond to probes
   * 4. Heavy initialization (DB queries, loop starts) to run after server is ready
   *
   * @see https://docs.nestjs.com/fundamentals/lifecycle-events
   * @see Kubernetes best practice: HTTP server must be ready before heavy init
   */
  async onModuleInit() {
    this.logger.log(
      `Orchestrator Loop Service initialized (interval=${this.loopIntervalMs}ms, ` +
      `restartGrace=${this.restartGraceMs}ms)`,
    );

    // v5.11.2: Defer heavy initialization to allow HTTP server to start first
    // This is critical for Kubernetes probe success - the HTTP server MUST be
    // listening before probes run, otherwise pods will be killed.
    //
    // NOTE: setImmediate is NOT sufficient as it runs before app.listen() in main.ts.
    // We use a 2-second delay to ensure the HTTP server has time to bind to port 8080.
    // This is a pragmatic solution that works with NestJS's synchronous bootstrap.
    const STARTUP_DELAY_MS = 2000;
    this.logger.log(`Deferring goal run resumption for ${STARTUP_DELAY_MS}ms to allow HTTP server startup`);

    setTimeout(() => {
      this.logger.log('HTTP server should be ready, resuming active goal runs');
      this.resumeActiveGoalRuns()
        .then(() => {
          this.logger.log('Active goal runs resumed successfully');
        })
        .catch((error) => {
          this.logger.error(`Failed to resume active goal runs: ${error.message}`, error.stack);
        });
    }, STARTUP_DELAY_MS);
  }

  /**
   * v1.7.0: Check if we're in the restart grace window
   * During grace, we should only reconcile state, not timeout/replan
   */
  private isInRestartGraceWindow(): boolean {
    return Date.now() - this.processStartAt < this.restartGraceMs;
  }

  /**
   * v1.7.0: Get remaining restart grace time in milliseconds
   */
  private getRestartGraceRemainingMs(): number {
    return Math.max(0, this.restartGraceMs - (Date.now() - this.processStartAt));
  }

  /**
   * v1.7.0: Mark a goal run as reconciled after restart
   * Once reconciled, normal timeout/replan logic applies
   */
  private markGoalRunReconciled(goalRunId: string): void {
    if (!this.reconciledGoalRuns.has(goalRunId)) {
      this.reconciledGoalRuns.add(goalRunId);
      this.logger.log(`Goal run ${goalRunId} reconciled after restart`);
    }
  }

  /**
   * v1.7.0: Check if a goal run needs reconciliation after restart
   * Returns true if:
   * 1. We're in restart grace window AND
   * 2. This goal run hasn't been reconciled yet
   */
  private needsReconciliation(goalRunId: string): boolean {
    return this.isInRestartGraceWindow() && !this.reconciledGoalRuns.has(goalRunId);
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down orchestrator loops');
    // Stop all active loops
    for (const [goalRunId, loop] of this.activeLoops) {
      this.stopLoop(goalRunId);
    }
  }

  /**
   * Start the orchestrator loop for a goal run
   */
  async startLoop(goalRunId: string): Promise<void> {
    if (this.activeLoops.has(goalRunId)) {
      this.logger.warn(`Loop already running for goal run ${goalRunId}`);
      return;
    }

    this.logger.log(`Starting orchestrator loop for goal run ${goalRunId} (interval=${this.loopIntervalMs}ms)`);

    const loop: ActiveLoop = {
      goalRunId,
      intervalId: setInterval(() => this.runLoopIteration(goalRunId), this.loopIntervalMs),
      isRunning: true,
    };

    this.activeLoops.set(goalRunId, loop);
    this.replanCounts.set(goalRunId, 0);

    // Run first iteration immediately
    await this.runLoopIteration(goalRunId);
  }

  /**
   * Stop the orchestrator loop for a goal run
   */
  stopLoop(goalRunId: string): void {
    const loop = this.activeLoops.get(goalRunId);
    if (loop) {
      clearInterval(loop.intervalId);
      loop.isRunning = false;
      this.activeLoops.delete(goalRunId);
      this.replanCounts.delete(goalRunId);
      this.logger.log(`Stopped orchestrator loop for goal run ${goalRunId}`);
    }
  }

  /**
   * Get loop status
   */
  getLoopStatus(goalRunId: string): { running: boolean; replanCount: number } {
    const loop = this.activeLoops.get(goalRunId);
    return {
      running: loop?.isRunning || false,
      replanCount: this.replanCounts.get(goalRunId) || 0,
    };
  }

  /**
   * Event handler for goal run started
   */
  @OnEvent('goal-run.started')
  async handleGoalRunStarted(payload: { goalRunId: string }) {
    await this.startLoop(payload.goalRunId);
  }

  /**
   * Event handler for goal run paused
   */
  @OnEvent('goal-run.paused')
  handleGoalRunPaused(payload: { goalRunId: string }) {
    // Don't stop the loop, just let it handle the PAUSED phase
    this.logger.log(`Goal run ${payload.goalRunId} paused`);
  }

  /**
   * Event handler for goal run cancelled/completed/failed
   */
  @OnEvent('goal-run.cancelled')
  @OnEvent('goal-run.completed')
  @OnEvent('goal-run.failed')
  handleGoalRunEnded(payload: { goalRunId: string }) {
    this.stopLoop(payload.goalRunId);
  }

  /**
   * v2.2.0: Event handler for step completion - updates Manus-style checkpoint
   *
   * This keeps the checkpoint current after every step completion,
   * implementing the Manus pattern of "constantly rewriting the todo list"
   * to keep completed work in the model's recent attention span.
   */
  @OnEvent('activity.STEP_COMPLETED')
  async handleStepCompleted(payload: { goalRunId: string; checklistItemId: string }) {
    if (!payload.goalRunId) return;

    this.logger.debug(`Step completed, updating checkpoint for goal run ${payload.goalRunId}`);

    try {
      await this.goalCheckpointService.updateCheckpoint(payload.goalRunId);
    } catch (error) {
      this.logger.warn(`Failed to update checkpoint after step completion: ${(error as Error).message}`);
    }
  }

  // Private methods

  /**
   * Run a single iteration of the orchestrator loop
   * v1.7.0: Wrapped in DbTransientService for graceful DB restart handling
   */
  private async runLoopIteration(goalRunId: string): Promise<void> {
    const loop = this.activeLoops.get(goalRunId);
    if (!loop?.isRunning) return;

    // v1.7.0: Check if we're in DB backoff before attempting any DB operations
    if (this.dbTransientService.isInBackoff()) {
      const remainingMs = this.dbTransientService.getBackoffRemainingMs();
      this.logger.debug(
        `Loop iteration for ${goalRunId} skipped - DB backoff (${Math.round(remainingMs / 1000)}s remaining)`,
      );
      return;
    }

    // v1.7.0: Wrap the entire loop iteration in transient guard
    await this.dbTransientService.withTransientGuard(
      async () => {
        await this.runLoopIterationCore(goalRunId);
      },
      `OrchestratorLoop.${goalRunId}`,
      {
        onTransientError: async (error, backoffMs) => {
          // v1.7.0: Throttled activity event emission for DB unavailable
          if (this.dbTransientService.shouldEmitDbUnavailableActivity()) {
            this.dbTransientService.markActivityEmitted();
            // Note: We can't emit activity event during DB outage, but log it
            this.logger.warn(
              `DB unavailable for goal run ${goalRunId}, pausing orchestration ` +
              `(backoff: ${Math.round(backoffMs / 1000)}s)`,
            );
          }
        },
        onNonTransientError: (error) => {
          // Non-transient errors are logged but we don't crash the loop
          this.logger.error(
            `Non-transient error in loop iteration for ${goalRunId}: ${error.message}`,
            error.stack,
          );
        },
      },
    );
  }

  /**
   * Core loop iteration logic (extracted for transient guard wrapper)
   * v1.7.0: Separated from runLoopIteration to enable DB transient wrapping
   */
  private async runLoopIterationCore(goalRunId: string): Promise<void> {
    // Get current goal run state
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
      include: {
        planVersions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: {
            checklistItems: {
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });

    if (!goalRun) {
      this.logger.error(`Goal run ${goalRunId} not found, stopping loop`);
      this.stopLoop(goalRunId);
      return;
    }

    // Check terminal states
    if (
      goalRun.status === GoalRunStatus.COMPLETED ||
      goalRun.status === GoalRunStatus.FAILED ||
      goalRun.status === GoalRunStatus.CANCELLED
    ) {
      this.stopLoop(goalRunId);
      return;
    }

    // Check for pending steering messages
    const pendingSteering = await this.goalRunService.getPendingSteering(goalRunId);
    if (pendingSteering) {
      await this.processSteering(goalRun, pendingSteering);
      return;
    }

    // Skip iteration if paused
    if (goalRun.phase === GoalRunPhase.PAUSED) {
      return;
    }

    // v2.0.0 Phase E: Skip execution if in maintenance mode
    // The maintenance mode service will pause goal runs when entering full maintenance
    if (this.maintenanceModeService.shouldSkipExecution()) {
      this.logger.debug(
        `Skipping loop iteration for ${goalRunId}: system in maintenance mode`,
      );
      return;
    }

    // Make decision based on current state
    const decision = await this.makeDecision(goalRun);

    // Execute decision
    await this.executeDecision(goalRun, decision);
  }

  /**
   * Make a decision about what to do next
   * v1.0.1: Fixed race condition - only trigger PLAN for INITIALIZING, not PLANNING
   */
  private async makeDecision(goalRun: any): Promise<LoopDecision> {
    const currentPlan = goalRun.planVersions[0];
    const items = currentPlan?.checklistItems || [];

    switch (goalRun.phase) {
      case GoalRunPhase.WAITING_USER_INPUT:
        // Stable durable wait state for USER_INPUT_REQUIRED steps
        return { action: 'CONTINUE' };

      case GoalRunPhase.INITIALIZING:
        // Only trigger PLAN for INITIALIZING phase
        // This prevents race condition where multiple iterations try to plan
        if (!currentPlan || items.length === 0) {
          return { action: 'PLAN' };
        }
        // Plan exists, move to execution
        return { action: 'EXECUTE' };

      case GoalRunPhase.PLANNING:
        // Planning is in progress - wait for it to complete
        // DO NOT trigger another PLAN action (prevents duplicate version error)
        if (!currentPlan || items.length === 0) {
          return { action: 'CONTINUE' };
        }
        // Plan exists, move to execution
        return { action: 'EXECUTE' };

      case GoalRunPhase.EXECUTING:
      case GoalRunPhase.CONTROLLING_DESKTOP:
        // Find next item to execute
        const pendingItem = items.find(
          (item: any) => item.status === ChecklistItemStatus.PENDING,
        );
        const inProgressItem = items.find(
          (item: any) => item.status === ChecklistItemStatus.IN_PROGRESS,
        );

        if (inProgressItem) {
          // v1.7.0: During restart grace window, skip timeout evaluation
          // We need to reconcile task status first before deciding to timeout/replan
          if (this.needsReconciliation(goalRun.id)) {
            const graceRemaining = this.getRestartGraceRemainingMs();
            this.logger.debug(
              `Step ${inProgressItem.id} in progress - skipping timeout check during restart grace ` +
              `(${Math.round(graceRemaining / 1000)}s remaining)`,
            );
            // Mark as reconciled after first pass - we've seen the in-progress item
            // Next iteration will apply normal timeout logic if still in progress
            this.markGoalRunReconciled(goalRun.id);
            return { action: 'CONTINUE' };
          }

          // v1.8.0 Phase C: Get heartbeat health for dynamic timeout
          // Heartbeat health is the primary signal - times out when agent stops sending heartbeats
          const heartbeatHealth = this.taskDispatchService.getHeartbeatHealth(inProgressItem.id);
          const statusHealth = this.taskDispatchService.getStatusCheckHealth(inProgressItem.id);
          const lastProgressTime = this.taskDispatchService.getLastProgressTime(inProgressItem.id);

          // Use lastProgressTime if available, otherwise fall back to startedAt
          const effectiveStartTime = lastProgressTime?.getTime()
            || inProgressItem.startedAt?.getTime()
            || Date.now();
          const timeSinceProgress = Date.now() - effectiveStartTime;

          // v1.7.0: Skip timeout if DB is in backoff (can't trust time measurements)
          if (this.dbTransientService.isInBackoff()) {
            this.logger.debug(
              `Step ${inProgressItem.id} past timeout but DB is in backoff - waiting for recovery`,
            );
            return { action: 'CONTINUE' };
          }

          // v2.1.0: Heartbeat-based timeout with failure classification (Option C)
          // CRITICAL FIX: Heartbeat timeouts are TRANSIENT failures, use RETRY not REPLAN
          // This prevents consuming the replan budget on infrastructure issues.
          // Previous behavior (v1.8.0): REPLAN consumed replan budget → exhausted after 3 heartbeat gaps
          // New behavior (v2.1.0): RETRY uses separate heartbeat budget (5 retries)
          if (heartbeatHealth.shouldTimeout) {
            // Use failure classification service for intelligent retry/replan decision
            const classification = this.failureClassificationService.classifyHeartbeatTimeout(
              inProgressItem.id,
              heartbeatHealth.consecutiveUnhealthy,
              heartbeatHealth.lastHeartbeat ?? null, // Convert undefined to null
              {
                goalRunId: goalRun.id,
                stepDescription: inProgressItem.description,
                timeSinceProgress,
              },
            );

            this.logger.warn(
              `Step ${inProgressItem.id} heartbeat timeout: ` +
              `${heartbeatHealth.consecutiveUnhealthy} consecutive unhealthy checks, ` +
              `last heartbeat: ${heartbeatHealth.lastHeartbeat?.toISOString() || 'never'} → ` +
              `${classification.suggestedAction} (${classification.reasoning})`,
            );

            if (classification.suggestedAction === 'RETRY') {
              // Consume retry from heartbeat budget
              const retry = this.failureClassificationService.consumeRetry(
                inProgressItem.id,
                'HEARTBEAT',
              );

              if (retry) {
                return {
                  action: 'RETRY',
                  reason: `Heartbeat timeout (retry ${retry.retryCount}): ${inProgressItem.description}`,
                  itemId: inProgressItem.id,
                  retryCount: retry.retryCount,
                  retryDelayMs: retry.delayMs,
                };
              }
            }

            // Heartbeat retries exhausted - escalate to REPLAN
            // This now only happens after 5 heartbeat timeouts, not on first occurrence
            return {
              action: 'REPLAN',
              reason: `Heartbeat retries exhausted: ${inProgressItem.description}`,
              itemId: inProgressItem.id,
            };
          }

          // Fallback: Absolute TTL safeguard (30 minutes)
          // This prevents tasks from running forever if heartbeat tracking fails
          if (timeSinceProgress > MAX_STEP_TTL_MS) {
            if (statusHealth.isHealthy || statusHealth.consecutiveFailures > 24) {
              this.logger.warn(
                `Step ${inProgressItem.id} exceeded absolute TTL (${Math.round(MAX_STEP_TTL_MS / 60000)} min)`,
              );
              return {
                action: 'REPLAN',
                reason: `Step exceeded maximum time: ${inProgressItem.description}`,
                itemId: inProgressItem.id,
              };
            }
            // Status checks failing but within tolerance - continue waiting
            this.logger.warn(
              `Step ${inProgressItem.id} past TTL but status checks failing ` +
              `(${statusHealth.consecutiveFailures} failures) - waiting for recovery`,
            );
          }

          // Log heartbeat status for observability
          if (!heartbeatHealth.isHealthy && heartbeatHealth.hasActiveDispatch) {
            this.logger.debug(
              `Step ${inProgressItem.id} heartbeat unhealthy ` +
              `(${heartbeatHealth.consecutiveUnhealthy}/3 threshold)`,
            );
          }

          // v1.9.0 Phase D: Emit delay notifications for user awareness
          // Notify users when steps are taking longer than expected
          await this.emitDelayNotificationIfNeeded(
            goalRun.id,
            inProgressItem,
            timeSinceProgress,
          );

          // Wait for in-progress item
          return { action: 'CONTINUE' };
        }

        if (pendingItem) {
          return { action: 'EXECUTE', itemId: pendingItem.id };
        }

        // No pending items - check for failed items
        const failedItem = items.find(
          (item: any) => item.status === ChecklistItemStatus.FAILED,
        );
        if (failedItem) {
          // v1.1.1: Check if this is an infrastructure failure (should retry, not replan)
          const isInfraFailure = this.isInfrastructureFailure(failedItem);

          if (isInfraFailure) {
            // Infrastructure failure - retry the step instead of replanning
            const infraRetryCount = this.infraRetryCounts.get(failedItem.id) || 0;

            if (infraRetryCount >= MAX_INFRA_RETRIES) {
              // Exhausted infra retries - escalate to replan
              this.logger.warn(
                `Infrastructure retries exhausted (${MAX_INFRA_RETRIES}) for step ${failedItem.id}, ` +
                `escalating to replan`
              );
              // Clear infra retry tracking before escalating
              this.infraRetryCounts.delete(failedItem.id);
              this.infraRetryAfter.delete(failedItem.id);
              // Fall through to replan logic below
            } else {
              // Check if backoff period has elapsed
              const retryAfter = this.infraRetryAfter.get(failedItem.id) || 0;
              if (Date.now() < retryAfter) {
                // Still in backoff period - wait
                return { action: 'CONTINUE' };
              }

              // Calculate exponential backoff delay for next retry
              const retryDelay = INFRA_RETRY_BASE_DELAY_MS * Math.pow(2, infraRetryCount);

              return {
                action: 'RETRY',
                reason: `Infrastructure failure (retry ${infraRetryCount + 1}/${MAX_INFRA_RETRIES}): ${failedItem.actualOutcome}`,
                itemId: failedItem.id,
                retryCount: infraRetryCount + 1,
                retryDelayMs: retryDelay,
              };
            }
          }

          // Semantic failure - clear any infra retry tracking and proceed to replan
          this.infraRetryCounts.delete(failedItem.id);
          this.infraRetryAfter.delete(failedItem.id);

          const replanCount = this.replanCounts.get(goalRun.id) || 0;
          if (replanCount >= MAX_REPLAN_ATTEMPTS) {
            return {
              action: 'FAIL',
              reason: `Max replan attempts (${MAX_REPLAN_ATTEMPTS}) exceeded`,
            };
          }
          return {
            action: 'REPLAN',
            reason: `Step failed: ${failedItem.description}`,
            itemId: failedItem.id,
          };
        }

        // All items completed - verify
        const allCompleted = items.every(
          (item: any) =>
            item.status === ChecklistItemStatus.COMPLETED ||
            item.status === ChecklistItemStatus.SKIPPED,
        );
        if (allCompleted) {
          return { action: 'VERIFY' };
        }

        return { action: 'CONTINUE' };

      case GoalRunPhase.VERIFYING:
        // Verification phase - check if goal is achieved
        return { action: 'COMPLETE' };

      case GoalRunPhase.WAITING_APPROVAL:
        // Wait for approval - will be handled by steering
        return { action: 'CONTINUE' };

      case GoalRunPhase.REPLANNING:
        // Replan in progress
        return { action: 'CONTINUE' };

      default:
        return { action: 'CONTINUE' };
    }
  }

  /**
   * Execute the decided action
   */
  private async executeDecision(goalRun: any, decision: LoopDecision): Promise<void> {
    this.logger.debug(`Executing decision ${decision.action} for goal run ${goalRun.id}`);

    switch (decision.action) {
      case 'PLAN':
        await this.executePlanningPhase(goalRun);
        break;

      case 'EXECUTE':
        if (decision.itemId) {
          await this.executeStep(goalRun, decision.itemId);
        }
        break;

      case 'VERIFY':
        await this.executeVerificationPhase(goalRun);
        break;

      case 'REPLAN':
        // v1.9.0 Phase D: Clear delay notification for the failed item
        if (decision.itemId) {
          this.clearDelayNotification(decision.itemId);
        }
        await this.executeReplanningPhase(goalRun, decision.reason!, decision.itemId);
        break;

      case 'RETRY':
        // v2.1.0: Retry step for transient failures (doesn't consume replan budget)
        // Handles both infrastructure failures (v1.1.1) and heartbeat timeouts (v2.1.0)
        // Uses separate retry budgets managed by FailureClassificationService
        if (decision.itemId) {
          await this.executeTransientRetry(
            goalRun,
            decision.itemId,
            decision.retryCount || 1,
            decision.retryDelayMs || INFRA_RETRY_BASE_DELAY_MS,
            decision.reason || 'Transient failure',
          );
        }
        break;

      case 'COMPLETE':
        // v1.9.0 Phase D: Clear all delay notifications on completion
        this.delayNotifications.clear();
        await this.goalRunService.completeGoalRun(goalRun.id);
        break;

      case 'FAIL':
        // v1.9.0 Phase D: Clear all delay notifications on failure
        this.delayNotifications.clear();
        await this.goalRunService.failGoalRun(goalRun.id, decision.reason || 'Unknown failure');
        break;

      case 'CONTINUE':
      case 'PAUSE':
        // No action needed
        break;
    }
  }

  /**
   * Execute the planning phase
   * v1.0.1: Added atomic phase transition with optimistic locking to prevent race conditions
   */
  private async executePlanningPhase(goalRun: any): Promise<void> {
    this.logger.log(`Executing planning phase for goal run ${goalRun.id}`);

    // Stark Fix (Gold Standard): Goal Intake gate BEFORE planning.
    // If GoalSpec is INCOMPLETE, do not enter PLANNING; create/ensure GOAL_INTAKE prompt and WAIT.
    const intakeGate = await this.goalIntakeService.ensureGoalSpecReadyForPlanning({
      goalRunId: goalRun.id,
      tenantId: goalRun.tenantId,
    });
    if (!intakeGate.ready) {
      return;
    }

    // Atomic phase transition with optimistic locking
    // Only proceed if we can atomically move from INITIALIZING to PLANNING
    // This prevents race condition where multiple loop iterations try to plan concurrently
    const updated = await this.prisma.goalRun.updateMany({
      where: {
        id: goalRun.id,
        phase: GoalRunPhase.INITIALIZING, // Only if still INITIALIZING
      },
      data: {
        phase: GoalRunPhase.PLANNING,
      },
    });

    if (updated.count === 0) {
      // Another iteration already started planning, or phase changed
      this.logger.debug(
        `Planning already started for ${goalRun.id} (phase not INITIALIZING), skipping`,
      );
      return;
    }

    this.logger.log(`Acquired planning lock for goal run ${goalRun.id}`);

    try {
      await this.plannerService.generateInitialPlan(goalRun.id);
      await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.EXECUTING);
    } catch (error: any) {
      if (error instanceof PlannerFirstStepUserInputError) {
        await this.goalIntakeService.requestGoalIntakeFromPlannerError({
          goalRunId: goalRun.id,
          tenantId: goalRun.tenantId,
          error,
        });
        return;
      }

      this.logger.error(`Planning failed: ${error.message}`);
      await this.goalRunService.failGoalRun(goalRun.id, `Planning failed: ${error.message}`);
    }
  }

  /**
   * Execute a single step
   */
  private async executeStep(goalRun: any, itemId: string): Promise<void> {
    this.logger.log(`Executing step ${itemId} for goal run ${goalRun.id}`);

    const item = await this.prisma.checklistItem.findUnique({
      where: { id: itemId },
    });

    if (!item) return;

    // Stark Fix (Atom 2): USER_INPUT_REQUIRED steps are a user-interaction surface, never dispatched.
    // Prefer explicit step.type; fallback only on explicit machine flags (no NL matching).
    const isUserInputRequired =
      item.type === StepType.USER_INPUT_REQUIRED ||
      hasUserInteractionTool(item.suggestedTools);

    if (isUserInputRequired) {
      const kind =
        item.executionSurface === ExecutionSurface.DESKTOP || item.requiresDesktop
          ? UserPromptKind.DESKTOP_TAKEOVER
          : UserPromptKind.TEXT_CLARIFICATION;

      const prompt = await this.userPromptService.ensureOpenPromptForStep({
        tenantId: goalRun.tenantId,
        goalRunId: goalRun.id,
        checklistItemId: item.id,
        kind,
        payload: {
          goalRunId: goalRun.id,
          checklistItemId: item.id,
          step: {
            description: item.description,
            expectedOutcome: item.expectedOutcome,
            suggestedTools: item.suggestedTools,
          },
        },
      });

      const blockedAt = new Date();
      const stepBlocked = await this.prisma.checklistItem.updateMany({
        where: {
          id: item.id,
          status: {
            in: [ChecklistItemStatus.PENDING, ChecklistItemStatus.IN_PROGRESS],
          },
        },
        data: {
          status: ChecklistItemStatus.BLOCKED,
          blockedByPromptId: prompt.id,
          blockedReason: 'INPUT_REQUIRED',
          blockedAt,
          startedAt: item.startedAt ?? new Date(),
          completedAt: null,
          actualOutcome: JSON.stringify(
            {
              blockedReason: 'WAITING_USER_INPUT',
              promptId: prompt.id,
              promptKind: prompt.kind,
            },
            null,
            2,
          ),
        },
      });

      const phaseUpdated = await this.prisma.goalRun.updateMany({
        where: {
          id: goalRun.id,
          phase: {
            in: [GoalRunPhase.EXECUTING, GoalRunPhase.CONTROLLING_DESKTOP],
          },
        },
        data: { phase: GoalRunPhase.WAITING_USER_INPUT },
      });

      // Emit one activity event on the first transition only (prevents 5s loop spam).
      if (stepBlocked.count > 0 || phaseUpdated.count > 0) {
        this.eventEmitter.emit('goal-run.phase-changed', {
          goalRunId: goalRun.id,
          previousPhase: goalRun.phase,
          newPhase: GoalRunPhase.WAITING_USER_INPUT,
        });

        await this.goalRunService.createActivityEvent(goalRun.id, {
          eventType: 'USER_PROMPT_CREATED',
          title: `Waiting for user input: ${item.description}`,
          severity: 'warning',
          checklistItemId: item.id,
          details: {
            promptId: prompt.id,
            promptKind: prompt.kind,
            dedupeKey: prompt.dedupeKey,
          },
        });
      }

      await this.outboxService.enqueueOnce({
        dedupeKey: prompt.dedupeKey,
        aggregateId: goalRun.id,
        eventType: 'user_prompt.created',
        payload: {
          promptId: prompt.id,
          goalRunId: goalRun.id,
          tenantId: goalRun.tenantId,
          checklistItemId: item.id,
          kind: prompt.kind,
          stepDescription: item.description,
        },
      });

      return;
    }

    // Mark item as in progress
    await this.prisma.checklistItem.update({
      where: { id: itemId },
      data: {
        status: ChecklistItemStatus.IN_PROGRESS,
        startedAt: new Date(),
      },
    });

    // Update phase if desktop is required
    if (item.requiresDesktop) {
      await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.CONTROLLING_DESKTOP);
    }

    await this.goalRunService.createActivityEvent(goalRun.id, {
      eventType: 'STEP_STARTED',
      title: `Starting: ${item.description}`,
      checklistItemId: itemId,
    });

    try {
      // v1.1.0: Create workflow if not exists (with link-first pattern)
      if (!goalRun.workflowRunId) {
        const workflowRunId = await this.createWorkflowForGoalRun(goalRun);
        goalRun.workflowRunId = workflowRunId;
      }

      // v1.1.0: Check workspace readiness before executing (capacity backpressure)
      const workspaceStatus = await this.ensureWorkspaceReadyForStep(goalRun);

      if (!workspaceStatus.ready) {
        if (workspaceStatus.waitingForCapacity) {
          // Capacity issue - don't mark as failed, don't replan
          // The workspace nextAttemptAt field handles retry timing (v1.5.0)
          // Activity emission is throttled in ensureWorkspaceReadyForStep

          // Mark step as pending again (not in progress, not failed)
          await this.prisma.checklistItem.update({
            where: { id: itemId },
            data: {
              status: ChecklistItemStatus.PENDING,
              startedAt: null,
            },
          });

          // v1.5.0: Activity emission throttling - check last activity event for this step
          const recentActivity = await this.prisma.activityEvent.findFirst({
            where: {
              goalRunId: goalRun.id,
              checklistItemId: itemId,
              eventType: 'STEP_WAITING_CAPACITY',
              createdAt: { gte: new Date(Date.now() - 60000) }, // Last 60 seconds
            },
            orderBy: { createdAt: 'desc' },
          });

          if (!recentActivity) {
            await this.goalRunService.createActivityEvent(goalRun.id, {
              eventType: 'STEP_WAITING_CAPACITY',
              title: `Waiting for capacity: ${item.description}`,
              description: `Desktop workspace not available, retrying in ${Math.ceil((workspaceStatus.retryAfterMs || 30000) / 1000)}s`,
              severity: 'warning',
              checklistItemId: itemId,
            });
          }

          return; // Exit without failing - will retry on next loop
        }

        // Non-capacity failure - workspace provisioning truly failed
        throw new Error(workspaceStatus.error || 'Workspace not ready');
      }

      // Workspace is ready - execute the step
      await this.executeStepViaWorkflow(goalRun, item);
    } catch (error: any) {
      this.logger.error(`Step execution failed: ${error.message}`);

      await this.prisma.checklistItem.update({
        where: { id: itemId },
        data: {
          status: ChecklistItemStatus.FAILED,
          actualOutcome: error.message,
          completedAt: new Date(),
        },
      });

      await this.goalRunService.createActivityEvent(goalRun.id, {
        eventType: 'STEP_FAILED',
        title: `Failed: ${item.description}`,
        description: error.message,
        severity: 'error',
        checklistItemId: itemId,
      });
    }
  }

  /**
   * Execute step via workflow system
   */
  private async executeStepViaWorkflow(goalRun: any, item: any): Promise<void> {
    // Create workflow node for this checklist item
    const nodeId = `node-${createId()}`;

    await this.prisma.workflowNode.create({
      data: {
        id: nodeId,
        workflowRunId: goalRun.workflowRunId,
        name: item.description,
        type: 'TASK',
        config: {
          description: item.description,
          expectedOutcome: item.expectedOutcome,
          suggestedTools: item.suggestedTools,
        },
        order: item.order,
        status: NodeStatus.READY,
        allowedTools: item.suggestedTools || [],
      },
    });

    // Link checklist item to workflow node
    await this.prisma.checklistItem.update({
      where: { id: item.id },
      data: { workflowNodeId: nodeId },
    });

    // Emit event for node execution (handled by existing workflow executor)
    this.eventEmitter.emit('workflow.node-ready', {
      workflowRunId: goalRun.workflowRunId,
      nodeId,
      goalRunId: goalRun.id,
      checklistItemId: item.id,
    });
  }

  /**
   * Create workflow run for goal run
   * v1.1.0: CRITICAL FIX - Link first, provision second pattern
   *
   * This prevents the runaway loop bug where failed provisioning caused
   * new workflows to be created on each loop iteration.
   *
   * Sequence (MUST be in this order):
   * 1. Create workflow record (DB only, no provisioning)
   * 2. Link to goalRun (so next iteration won't create another workflow)
   * 3. Attempt workspace provisioning (may fail, that's OK)
   * 4. Start workflow if provisioning succeeded
   *
   * If provisioning fails:
   * - Workflow record exists and is linked
   * - Next iteration will retry provisioning, NOT create new workflow
   * - Capacity issues use exponential backoff, not replanning
   */
  private async createWorkflowForGoalRun(goalRun: any): Promise<string> {
    // STEP 1: Create workflow RECORD only (no provisioning yet)
    const workflowResult = await this.workflowService.createWorkflowRecord({
      tenantId: goalRun.tenantId,
      name: `Goal: ${goalRun.goal.substring(0, 50)}`,
      description: goalRun.goal,
      nodes: [], // Nodes will be added as checklist items are executed
      persistence: {
        enabled: true,
      },
    });

    this.logger.log(
      `Created workflow record ${workflowResult.id} for goal ${goalRun.id} ` +
      `(linking before provisioning - prevents runaway loop)`
    );

    // STEP 2: LINK FIRST - This is the critical fix!
    // Even if provisioning fails, the workflow is linked.
    // Next loop iteration will see workflowRunId and NOT create another workflow.
    await this.goalRunService.linkWorkflowRun(goalRun.id, workflowResult.id);

    this.logger.log(`Linked workflow ${workflowResult.id} to goal ${goalRun.id}`);

    // STEP 3: Attempt workspace provisioning (may fail, that's OK)
    const provisionResult = await this.workflowService.ensureWorkspaceProvisioned(
      workflowResult.id,
      goalRun.tenantId,
      { enabled: true },
    );

    if (provisionResult.success) {
      // STEP 4: Start the workflow only if provisioning succeeded
      await this.workflowService.startWorkflow(workflowResult.id);
      this.logger.log(`Workflow ${workflowResult.id} started successfully`);
    } else if (provisionResult.status === WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY) {
      // Capacity issue - log it, but don't fail or replan
      this.logger.warn(
        `Workflow ${workflowResult.id} waiting for capacity ` +
        `(retry in ${Math.ceil((provisionResult.retryAfterMs || 30000) / 1000)}s)`
      );

      // Create activity event for visibility
      await this.goalRunService.createActivityEvent(goalRun.id, {
        eventType: 'WAITING_FOR_CAPACITY',
        title: 'Waiting for desktop capacity',
        description: `Workspace provisioning will retry in ${Math.ceil((provisionResult.retryAfterMs || 30000) / 1000)} seconds`,
        severity: 'warning',
      });
    } else {
      // Provisioning failed (not capacity) - this is a real error
      this.logger.error(`Workflow ${workflowResult.id} provisioning failed: ${provisionResult.error}`);
      // Don't throw - the workflow is linked, executeStep will handle the failed state
    }

    return workflowResult.id;
  }

  /**
   * v1.1.0: Ensure workspace is ready before executing steps
   * v1.5.0: Added DB-driven retry gating to prevent tight loop bug
   *
   * Called at the start of step execution to:
   * 1. Check if workspace is provisioned (READY)
   * 2. If WAITING_FOR_CAPACITY with nextAttemptAt in future, skip without calling API
   * 3. If FAILED, return error
   */
  private async ensureWorkspaceReadyForStep(goalRun: any): Promise<{
    ready: boolean;
    waitingForCapacity: boolean;
    retryAfterMs?: number;
    error?: string;
  }> {
    if (!goalRun.workflowRunId) {
      return { ready: false, waitingForCapacity: false, error: 'No workflow linked' };
    }

    // v1.5.0: Check workspace nextAttemptAt BEFORE calling ensureWorkspaceProvisioned
    // This prevents the tight loop bug where we call the API every second
    const workflow = await this.prisma.workflowRun.findUnique({
      where: { id: goalRun.workflowRunId },
      include: { workspace: true },
    });

    if (workflow?.workspace) {
      const workspace = workflow.workspace;
      const nextAttemptAt = (workspace as any).nextAttemptAt;
      const lastActivityEmittedAt = (workspace as any).lastActivityEmittedAt;

      // If workspace is waiting for capacity and nextAttemptAt is in the future, skip
      if (
        workspace.status === WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY &&
        nextAttemptAt &&
        new Date(nextAttemptAt) > new Date()
      ) {
        const retryAfterMs = new Date(nextAttemptAt).getTime() - Date.now();

        // v1.5.0: Activity emission throttling - only log every 60 seconds
        const shouldEmitActivity = !lastActivityEmittedAt ||
          (Date.now() - new Date(lastActivityEmittedAt).getTime() > 60000);

        if (shouldEmitActivity) {
          this.logger.debug(
            `Workspace ${workspace.id} waiting for capacity, skipping until ${new Date(nextAttemptAt).toISOString()}`
          );

          // Update lastActivityEmittedAt to throttle future logs
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: { lastActivityEmittedAt: new Date() },
          });
        }

        return {
          ready: false,
          waitingForCapacity: true,
          retryAfterMs,
        };
      }

      // If workspace is already READY, return success without calling API
      if (workspace.status === WorkspaceProvisioningStatus.READY) {
        return { ready: true, waitingForCapacity: false };
      }
    }

    // Call ensureWorkspaceProvisioned only if workspace is not in a known state
    const provisionResult = await this.workflowService.ensureWorkspaceProvisioned(
      goalRun.workflowRunId,
      goalRun.tenantId,
      { enabled: true },
    );

    if (provisionResult.success) {
      return { ready: true, waitingForCapacity: false };
    }

    if (provisionResult.status === WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY) {
      return {
        ready: false,
        waitingForCapacity: true,
        retryAfterMs: provisionResult.retryAfterMs,
      };
    }

    return {
      ready: false,
      waitingForCapacity: false,
      error: provisionResult.error || 'Workspace provisioning failed',
    };
  }

  /**
   * Execute the verification phase
   */
  private async executeVerificationPhase(goalRun: any): Promise<void> {
    this.logger.log(`Executing verification phase for goal run ${goalRun.id}`);

    await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.VERIFYING);

    await this.goalRunService.createActivityEvent(goalRun.id, {
      eventType: 'VERIFICATION_STARTED',
      title: 'Verifying goal completion',
    });

    // For now, simple verification: all steps completed = goal completed
    // Future: LLM-based verification
    const currentPlan = goalRun.planVersions[0];
    const items = currentPlan?.checklistItems || [];

    const allCompleted = items.every(
      (item: any) =>
        item.status === ChecklistItemStatus.COMPLETED ||
        item.status === ChecklistItemStatus.SKIPPED,
    );

    if (allCompleted) {
      await this.goalRunService.createActivityEvent(goalRun.id, {
        eventType: 'VERIFICATION_PASSED',
        title: 'Goal verification passed',
      });
      await this.goalRunService.completeGoalRun(goalRun.id);

      // v1.5.0: Complete workflow to trigger workspace hibernation
      // This was missing, causing workspaces to never hibernate
      if (goalRun.workflowRunId) {
        try {
          await this.workflowService.completeWorkflow(goalRun.workflowRunId, WorkflowStatus.COMPLETED);
          this.logger.log(`Workflow ${goalRun.workflowRunId} completed and workspace hibernated`);
        } catch (error: any) {
          // Log but don't fail - orphan GC will clean up
          this.logger.warn(`Failed to complete workflow ${goalRun.workflowRunId}: ${error.message}`);
        }
      }
    } else {
      await this.goalRunService.createActivityEvent(goalRun.id, {
        eventType: 'VERIFICATION_FAILED',
        title: 'Goal verification failed',
        description: 'Not all steps completed successfully',
        severity: 'warning',
      });
      // Trigger replan
      await this.executeReplanningPhase(goalRun, 'Verification failed - not all steps completed');
    }
  }

  /**
   * Execute the replanning phase
   */
  private async executeReplanningPhase(
    goalRun: any,
    reason: string,
    failedItemId?: string,
  ): Promise<void> {
    this.logger.log(`Executing replanning phase for goal run ${goalRun.id}: ${reason}`);

    // Increment replan count
    const currentCount = this.replanCounts.get(goalRun.id) || 0;
    this.replanCounts.set(goalRun.id, currentCount + 1);

    if (currentCount + 1 > MAX_REPLAN_ATTEMPTS) {
      await this.goalRunService.failGoalRun(
        goalRun.id,
        `Max replan attempts (${MAX_REPLAN_ATTEMPTS}) exceeded. Last reason: ${reason}`,
      );

      // v1.5.0: Cancel workflow to trigger workspace hibernation
      if (goalRun.workflowRunId) {
        try {
          await this.workflowService.cancelWorkflow(goalRun.workflowRunId, 'Goal run failed');
          this.logger.log(`Workflow ${goalRun.workflowRunId} cancelled and workspace hibernated`);
        } catch (error: any) {
          this.logger.warn(`Failed to cancel workflow ${goalRun.workflowRunId}: ${error.message}`);
        }
      }
      return;
    }

    await this.goalRunService.createActivityEvent(goalRun.id, {
      eventType: 'REPLAN_STARTED',
      title: 'Generating new plan',
      description: reason,
    });

    try {
      await this.plannerService.generateReplan(goalRun.id, reason, {
        failedItemId,
      });
      await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.EXECUTING);
    } catch (error: any) {
      if (error instanceof PlannerFirstStepUserInputError) {
        await this.goalIntakeService.requestGoalIntakeFromPlannerError({
          goalRunId: goalRun.id,
          tenantId: goalRun.tenantId,
          error,
        });
        return;
      }

      this.logger.error(`Replanning failed: ${error.message}`);
      await this.goalRunService.failGoalRun(goalRun.id, `Replanning failed: ${error.message}`);
    }
  }

  /**
   * v1.1.1: Check if a failed checklist item is an infrastructure failure
   *
   * Infrastructure failures are marked with [INFRA] prefix in actualOutcome
   * by the task-dispatch.service.ts markAsInfrastructureFailure method.
   *
   * Infrastructure failures should be retried, not replanned, because:
   * - They're transient (network, 404, timeout, capacity)
   * - The step logic is correct, just the execution environment failed
   * - Replanning wastes the replan budget on non-semantic issues
   */
  private isInfrastructureFailure(item: any): boolean {
    if (!item.actualOutcome) return false;

    const outcome = String(item.actualOutcome);

    // Check for [INFRA] prefix (set by task-dispatch.service.ts)
    if (outcome.startsWith('[INFRA]') || outcome.includes('[INFRA]')) {
      return true;
    }

    // Also check for common infrastructure error patterns
    // These may come from other sources (workflow service, direct errors)
    const infraPatterns = [
      'INFRA_LOOKUP_FAILED',
      'Task not found',
      '404',
      '503',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network error',
      'Agent unreachable',
      'Workspace not ready',
      'capacity',
    ];

    const lowerOutcome = outcome.toLowerCase();
    return infraPatterns.some(pattern =>
      lowerOutcome.includes(pattern.toLowerCase())
    );
  }

  /**
   * v2.1.0: Execute transient retry for a failed/timed-out step
   *
   * This resets the step to PENDING so it will be re-executed on the next loop.
   * Does NOT consume replan budget - transient failures are recoverable.
   *
   * Handles both:
   * - Infrastructure failures (v1.1.1): 404, network errors, capacity issues
   * - Heartbeat timeouts (v2.1.0): Agent not responding, connection gaps
   *
   * Uses exponential backoff to avoid hammering the infrastructure.
   * Retry budgets are managed by FailureClassificationService.
   */
  private async executeTransientRetry(
    goalRun: any,
    itemId: string,
    retryCount: number,
    retryDelayMs: number,
    reason: string,
  ): Promise<void> {
    // Detect retry type for proper logging and event tracking
    const isHeartbeatRetry = reason.toLowerCase().includes('heartbeat');
    const retryType = isHeartbeatRetry ? 'Heartbeat' : 'Infrastructure';

    this.logger.log(
      `${retryType} retry ${retryCount} for step ${itemId} ` +
      `(delay: ${Math.round(retryDelayMs / 1000)}s): ${reason}`,
    );

    // Update retry tracking (for legacy infra retries; heartbeat uses classification service)
    if (!isHeartbeatRetry) {
      this.infraRetryCounts.set(itemId, retryCount);
      this.infraRetryAfter.set(itemId, Date.now() + retryDelayMs);
    }

    // Get item details for activity event
    const item = await this.prisma.checklistItem.findUnique({
      where: { id: itemId },
    });

    // Get error history for diagnostics (Manus-style error preservation)
    const errorHistory = this.failureClassificationService.getErrorHistory(itemId);
    const diagnosticSummary = errorHistory.length > 1
      ? ` Previous attempts: ${errorHistory.length - 1}.`
      : '';

    // Reset step to PENDING for retry
    // v2.1.0: Preserve error context in actualOutcome for debugging
    // This implements Manus-style "error as learning" pattern
    const retryContext = JSON.stringify({
      lastRetryAt: new Date().toISOString(),
      retryCount,
      retryType,
      reason,
      errorHistory: errorHistory.slice(-3), // Keep last 3 attempts
    });

    await this.prisma.checklistItem.update({
      where: { id: itemId },
      data: {
        status: ChecklistItemStatus.PENDING,
        startedAt: null,
        completedAt: null,
        // Store retry context in actualOutcome (will be overwritten on next attempt)
        actualOutcome: `[RETRY:${retryCount}] ${reason} | Context: ${retryContext}`,
      },
    });

    // Create activity event for visibility
    await this.goalRunService.createActivityEvent(goalRun.id, {
      eventType: isHeartbeatRetry ? 'STEP_HEARTBEAT_RETRY' : 'STEP_INFRA_RETRY',
      title: `Retrying: ${item?.description || 'Unknown step'}`,
      description: `${retryType} retry ${retryCount}. ` +
        `Next attempt in ${Math.round(retryDelayMs / 1000)} seconds. ` +
        `Reason: ${reason}.${diagnosticSummary}`,
      severity: 'warning',
      checklistItemId: itemId,
    });

    this.logger.log(
      `Step ${itemId} reset to PENDING for ${retryType.toLowerCase()} retry ` +
      `(will retry in ${Math.round(retryDelayMs / 1000)}s)`,
    );
  }

  /**
   * Process steering message
   */
  private async processSteering(goalRun: any, steering: any): Promise<void> {
    this.logger.log(`Processing steering message ${steering.id} for goal run ${goalRun.id}`);

    await this.goalRunService.acknowledgeSteering(steering.id);

    switch (steering.type) {
      case 'INSTRUCTION':
        // Handle user instruction - may trigger replan
        if (steering.content) {
          await this.executeReplanningPhase(goalRun, `User instruction: ${steering.content}`);
        }
        break;

      case 'MODIFY_PLAN':
        // Handle plan modification
        await this.executeReplanningPhase(goalRun, `User requested plan modification`);
        break;

      case 'APPROVE':
        // Resume from waiting approval
        if (goalRun.phase === GoalRunPhase.WAITING_APPROVAL) {
          await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.EXECUTING);
        }
        break;

      case 'REJECT':
        // Handle rejection
        if (steering.targetItemId) {
          await this.prisma.checklistItem.update({
            where: { id: steering.targetItemId },
            data: { status: ChecklistItemStatus.SKIPPED },
          });
        }
        await this.goalRunService.updatePhase(goalRun.id, GoalRunPhase.EXECUTING);
        break;

      // PAUSE, RESUME, CANCEL handled directly by GoalRunService.submitSteering
    }

    await this.prisma.steeringMessage.update({
      where: { id: steering.id },
      data: { processedAt: new Date() },
    });
  }

  /**
   * v1.9.0 Phase D: Emit delay notification if step is taking longer than expected
   *
   * Notifies users when steps exceed warning (1 min) or critical (3 min) thresholds.
   * Uses rate limiting to avoid notification spam (max once per minute per item).
   *
   * This improves UX by:
   * - Keeping users informed about long-running tasks
   * - Distinguishing between "working but slow" vs "stuck"
   * - Providing transparency into what's happening
   */
  private async emitDelayNotificationIfNeeded(
    goalRunId: string,
    item: any,
    timeSinceProgress: number,
  ): Promise<void> {
    const itemId = item.id;
    const now = Date.now();

    // Determine severity level based on delay duration
    let severity: 'warning' | 'critical' | null = null;
    if (timeSinceProgress >= DELAY_CRITICAL_THRESHOLD_MS) {
      severity = 'critical';
    } else if (timeSinceProgress >= DELAY_WARNING_THRESHOLD_MS) {
      severity = 'warning';
    }

    // No delay yet - nothing to notify
    if (!severity) {
      return;
    }

    // Check rate limiting - don't spam notifications
    const lastNotification = this.delayNotifications.get(itemId);
    if (lastNotification) {
      const timeSinceLastNotification = now - lastNotification.lastNotifiedAt;

      // Don't notify if we notified recently
      if (timeSinceLastNotification < DELAY_NOTIFICATION_INTERVAL_MS) {
        return;
      }

      // If severity is the same, skip (already notified at this level)
      // Only re-notify if escalating from warning to critical
      if (lastNotification.severity === severity) {
        // Update timestamp but don't emit (periodic logging only)
        this.delayNotifications.set(itemId, { lastNotifiedAt: now, severity });
        return;
      }
    }

    // Calculate human-readable duration
    const minutes = Math.floor(timeSinceProgress / 60000);
    const seconds = Math.floor((timeSinceProgress % 60000) / 1000);
    const durationText = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    // Emit appropriate event based on severity
    const eventType = severity === 'critical' ? 'STEP_DELAY_CRITICAL' : 'STEP_DELAY_WARNING';
    const title = severity === 'critical'
      ? `Step taking longer than expected (${durationText})`
      : `Step still in progress (${durationText})`;
    const description = severity === 'critical'
      ? `"${item.description}" has been running for ${durationText}. The agent is still working.`
      : `"${item.description}" is taking longer than usual. The agent is still working.`;

    // Log for observability
    this.logger.log(
      `Step ${itemId} delay ${severity}: ${durationText} elapsed, emitting ${eventType}`,
    );

    // Emit activity event
    await this.goalRunService.createActivityEvent(goalRunId, {
      eventType,
      title,
      description,
      severity,
      checklistItemId: itemId,
      details: {
        durationMs: timeSinceProgress,
        durationText,
        threshold: severity === 'critical'
          ? DELAY_CRITICAL_THRESHOLD_MS
          : DELAY_WARNING_THRESHOLD_MS,
      },
    });

    // Update tracking
    this.delayNotifications.set(itemId, { lastNotifiedAt: now, severity });
  }

  /**
   * v1.9.0 Phase D: Clear delay notification tracking when step completes
   *
   * Called when a step transitions out of IN_PROGRESS state to clean up
   * the delay notification tracking for that item.
   */
  private clearDelayNotification(itemId: string): void {
    if (this.delayNotifications.has(itemId)) {
      this.delayNotifications.delete(itemId);
      this.logger.debug(`Cleared delay notification tracking for step ${itemId}`);
    }
  }

  /**
   * Resume active goal runs on startup
   * v1.7.0: Wrapped in transient guard for DB resilience during startup
   */
  private async resumeActiveGoalRuns(): Promise<void> {
    // v1.7.0: Wrap in transient guard - DB may not be ready immediately on startup
    const runningGoalRuns = await this.dbTransientService.withTransientGuard(
      async () => {
        return await this.prisma.goalRun.findMany({
          where: {
            status: GoalRunStatus.RUNNING,
            phase: {
              notIn: [GoalRunPhase.COMPLETED, GoalRunPhase.FAILED, GoalRunPhase.PAUSED],
            },
          },
        });
      },
      'OrchestratorLoop.resumeActiveGoalRuns',
      {
        skipIfInBackoff: false, // Always try on startup
        onTransientError: (error, backoffMs) => {
          this.logger.warn(
            `DB not ready during startup, will retry goal run resume ` +
            `(backoff: ${Math.round(backoffMs / 1000)}s): ${error.message}`,
          );
        },
      },
    );

    if (!runningGoalRuns) {
      // DB was unavailable - schedule a retry
      this.logger.warn('Could not resume goal runs - DB unavailable, will retry on next recovery');
      return;
    }

    this.logger.log(`Resuming ${runningGoalRuns.length} active goal runs`);

    for (const goalRun of runningGoalRuns) {
      await this.startLoop(goalRun.id);
    }
  }
}
