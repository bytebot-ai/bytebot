/**
 * Task Dispatch Service
 * v1.1.0: DB transient error resilience for polling
 * v1.0.0: Poll-based task execution adapter
 *
 * Purpose: Bridge between orchestrator's checklist/workflow model and
 * bytebot-agent's poll-based task system.
 *
 * Architecture Decision: Poll-based (not Push-based)
 * - Creates tasks via bytebot-agent's API (POST /tasks)
 * - Agent polls and claims tasks using claimNextTask()
 * - Orchestrator polls for task completion
 * - Updates checklist items based on results
 *
 * Key Features:
 * - Idempotent task creation using goalRunId:checklistItemId:attempt key
 * - Task completion detection via polling
 * - Graceful error handling and retry support
 * - Activity event emission for UI updates
 * - v1.1.0: DB transient error handling with backoff
 *
 * @see /docs/ORCHESTRATOR_FIXES_DEC_2025.md
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { DbTransientService } from './db-transient.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios, { AxiosInstance } from 'axios';
import {
  ChecklistItemStatus,
  ExecutionSurface,
  GoalRunExecutionEngine,
  GoalRunPhase,
  UserPromptKind,
  UserPromptStatus,
} from '@prisma/client';
import { UserPromptService } from './user-prompt.service';
import { OutboxService } from './outbox.service';

// Phase 12: Task-based model routing configuration
// Phase 14.1: Updated browser model from fara-7b to gpt-oss-120b (2026-01-07)
// - fara-7b was scaled down (0/0 replicas) causing LLM connection errors
// - gpt-oss-120b is running (1/1 replicas) with 131K context window
// - 120B parameter model provides superior reasoning for browser automation
//
// Routes tasks to appropriate in-house models based on execution surface:
// - Browser tasks (requiresDesktop: false) → gpt-oss-120b (high-capability reasoning)
// - Desktop tasks (requiresDesktop: true) → qwen3-vl-32b (vision-capable for GUI)
// - Fallback → claude-sonnet-4-5 (external API for complex reasoning)
//
// Model configuration for bytebot-agent's task schema
const BROWSER_TASK_MODEL = {
  name: 'openai/gpt-oss-120b',
  title: 'gpt-oss-120b',
  provider: 'proxy',
  contextWindow: 131072,
};

const DESKTOP_TASK_MODEL = {
  name: 'openai/qwen3-vl-32b',
  title: 'qwen3-vl-32b',
  provider: 'proxy',
  contextWindow: 32000,
};

// Fallback model for tasks that don't specify execution surface
// or when in-house models fail
const FALLBACK_TASK_MODEL = {
  name: 'anthropic/claude-sonnet-4-5-20250929',
  title: 'claude-sonnet-4-5',
  provider: 'proxy',
  contextWindow: 128000,
};

// Legacy constant for backward compatibility
const DEFAULT_TASK_MODEL = FALLBACK_TASK_MODEL;

// Phase 2.1: Transient error handling configuration
// Only treat status check failures as problematic after exceeding threshold
const STATUS_CHECK_FAILURE_THRESHOLD = 6; // After 6 failures (~30 seconds at 5s interval)
const STATUS_CHECK_FAILURE_WINDOW_MS = 120000; // 2 minutes of consecutive failures = stale

// v1.1.0: 404 tolerance configuration
// When a task is not found (404), it may have completed and been GC'd
// Enter grace window to allow fallback lookups before declaring failure
const NOTFOUND_GRACE_DEFAULT_MS = 60000; // 60 seconds to match TTL

// v1.2.0 Phase C: Heartbeat-based timeout configuration
// Agent sends heartbeat every 15 seconds. Orchestrator polls every 5 seconds.
// v5.8.0: Option C Industry Standard - Increased tolerance for browser automation
// Browser automation can block for 30-60+ seconds during:
// - Heavy page loads with large JS bundles
// - Complex form submissions and file uploads
// - PDF rendering and screenshot captures
// Best practice (per industry research): 90-120 second tolerance
// At 5s polling: 18 checks = 90 second tolerance before timeout
// Combined with new heartbeat retry budget (5 retries via FailureClassificationService),
// total tolerance before REPLAN is: 90s × 5 retries = 450 seconds (~7.5 minutes)
const HEARTBEAT_UNHEALTHY_THRESHOLD = 18; // Consecutive unhealthy checks before timeout (was 9)

// Failure type classification for replan semantics
type FailureType = 'SEMANTIC' | 'INFRASTRUCTURE' | 'UNKNOWN';

// v2.4.1: Context summarization configuration
// Prevents excessively long context from overwhelming the agent
const CONTEXT_SUMMARIZATION_CONFIG = {
  maxPreviousStepsDetailed: 5, // Show full detail for last N steps
  maxContextChars: 4000, // Max chars for previous step results
  summaryFormat: 'numbered', // 'numbered' or 'bullet'
};

// Task status in bytebot-agent system
type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'NEEDS_HELP' | 'NEEDS_REVIEW';

// Task dispatch request
interface TaskDispatchRequest {
  goalRunId: string;
  checklistItemId: string;
  planVersionId?: string;
  workspaceId?: string;
  // Task details
  title: string;
  description: string;
  expectedOutcome?: string;
  // Execution config
  allowedTools?: string[];
  highRiskTools?: string[];
  requiresDesktop?: boolean;
  executionSurface?: ExecutionSurface;
  // Retry tracking
  attempt?: number;
  // v2.4.0: Context propagation for autonomous operation
  // Helps agent understand broader context and proceed without asking for clarification
  goalContext?: string;
  previousStepResults?: string;
}

// Task created in agent system
interface AgentTask {
  id: string;
  description: string;
  title?: string;
  status: AgentTaskStatus;
  workspaceId?: string;
  nodeRunId?: string;
  requiresDesktop?: boolean;
  control?: 'USER' | 'ASSISTANT';
  result?: any;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

// Task dispatch result
interface TaskDispatchResult {
  success: boolean;
  taskId?: string;
  error?: string;
}

// v1.2.0 Phase C: Heartbeat health response from task controller
interface HeartbeatHealthResponse {
  taskId: string;
  phase: string;
  agentHeartbeat: string | null;
  heartbeatMissedCount: number;
  isHeartbeatHealthy: boolean;
  lastActivityAt: string | null;
  timeSinceHeartbeat: number | null;
}

// Dispatch record for tracking
interface DispatchRecord {
  idempotencyKey: string;
  taskId: string;
  goalRunId: string;
  checklistItemId: string;
  status: 'DISPATCHED' | 'RUNNING' | 'WAITING_USER' | 'COMPLETED' | 'FAILED' | 'INFRA_FAILED';
  createdAt: Date;
  completedAt?: Date;
  // Phase 2.1: Track status check health for transient error handling
  lastSuccessfulCheck?: Date;
  consecutiveCheckFailures: number;
  // v1.1.0: 404 tolerance tracking
  notFoundGraceStartedAt?: Date;  // When 404 grace window started
  notFoundCount: number;          // Number of 404s seen during grace window
  // v1.1.0: Failure type classification
  failureType?: FailureType;      // SEMANTIC = replan, INFRASTRUCTURE = retry
  // v1.2.0 Phase C: Heartbeat health tracking
  lastHeartbeatCheck?: Date;             // When we last checked heartbeat health
  lastHeartbeatTime?: Date;              // Agent's last heartbeat timestamp
  isHeartbeatHealthy: boolean;           // Current heartbeat health status
  consecutiveHeartbeatUnhealthy: number; // Consecutive unhealthy checks
}

@Injectable()
export class TaskDispatchService implements OnModuleInit {
  private readonly logger = new Logger(TaskDispatchService.name);
  private readonly httpClient: AxiosInstance;
  private readonly agentApiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly dispatchEnabled: boolean;
  // v1.1.0: 404 tolerance grace window configuration
  private readonly notFoundGraceMs: number;
  // v1.2.0 Phase C: Task controller client for heartbeat health
  private readonly taskControllerClient: AxiosInstance;
  private readonly taskControllerUrl: string;
  // v1.2.1: Configurable heartbeat unhealthy threshold for browser automation tolerance
  private readonly heartbeatUnhealthyThreshold: number;

  // In-memory dispatch tracking (for MVP, will move to DB)
  private dispatchRecords: Map<string, DispatchRecord> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly dbTransientService: DbTransientService,
    private readonly eventEmitter: EventEmitter2,
    private readonly userPromptService: UserPromptService,
    private readonly outboxService: OutboxService,
  ) {
    // Configure agent API connection (bytebot-agent service runs on port 9991)
    this.agentApiUrl = this.configService.get<string>('BYTEBOT_AGENT_API_URL', 'http://bytebot-agent:9991');
    this.pollIntervalMs = parseInt(
      this.configService.get<string>('TASK_POLL_INTERVAL_MS', '5000'),
      10,
    );
    this.dispatchEnabled = this.configService.get<string>('TASK_DISPATCH_ENABLED', 'true') === 'true';
    // v1.1.0: 404 tolerance grace window (matches task-controller TTL)
    this.notFoundGraceMs = parseInt(
      this.configService.get<string>('TASK_STATUS_NOTFOUND_GRACE_MS', String(NOTFOUND_GRACE_DEFAULT_MS)),
      10,
    );

    // Create HTTP client with timeout
    this.httpClient = axios.create({
      baseURL: this.agentApiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': this.configService.get<string>('INTERNAL_SERVICE_TOKEN', ''),
      },
    });

    // v1.2.0 Phase C: Task controller client for heartbeat health checks
    this.taskControllerUrl = this.configService.get<string>(
      'TASK_CONTROLLER_URL',
      'http://bytebot-task-controller:3000',
    );
    this.taskControllerClient = axios.create({
      baseURL: this.taskControllerUrl,
      timeout: 5000, // Short timeout for health checks
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // v1.2.1: Configurable heartbeat unhealthy threshold
    // Default 9 = 45 seconds at 5s polling (browser automation tolerance)
    // Old default was 3 = 15 seconds (too aggressive for browser automation)
    this.heartbeatUnhealthyThreshold = parseInt(
      this.configService.get<string>('HEARTBEAT_UNHEALTHY_THRESHOLD', String(HEARTBEAT_UNHEALTHY_THRESHOLD)),
      10,
    );
    this.logger.log(`Heartbeat unhealthy threshold: ${this.heartbeatUnhealthyThreshold} consecutive checks`);
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Task Dispatch Service initialized (enabled: ${this.dispatchEnabled}, ` +
      `agent: ${this.agentApiUrl}, taskController: ${this.taskControllerUrl})`,
    );

    if (this.dispatchEnabled) {
      // v5.11.4: Defer heavy initialization to allow HTTP server to start first
      // This is critical for Kubernetes probe success - the HTTP server MUST be
      // listening before probes run, otherwise pods will be killed.
      // Recovery of 67+ in-progress items can take minutes due to sequential API calls.
      const STARTUP_DELAY_MS = 3000;
      this.logger.log(`Deferring in-flight dispatch recovery for ${STARTUP_DELAY_MS}ms to allow HTTP server startup`);

      setTimeout(() => {
        this.logger.log('HTTP server should be ready, recovering in-flight dispatches');
        this.recoverInFlightDispatches()
          .then(() => {
            this.logger.log('In-flight dispatch recovery completed');
          })
          .catch((error) => {
            this.logger.error(`Failed to recover in-flight dispatches: ${error.message}`, error.stack);
          });
      }, STARTUP_DELAY_MS);
    }
  }

  /**
   * Generate idempotency key for task dispatch
   * Format: goalRunId:checklistItemId:attempt
   */
  private generateIdempotencyKey(goalRunId: string, checklistItemId: string, attempt: number = 1): string {
    return `${goalRunId}:${checklistItemId}:${attempt}`;
  }

  /**
   * Phase 12: Select model based on task execution surface
   *
   * Routes tasks to appropriate in-house models:
   * - Desktop tasks (requiresDesktop: true) → qwen3-vl-32b (vision model for GUI)
   * - Browser tasks (requiresDesktop: false) → fara-7b (optimized for web)
   * - Fallback when surface unspecified → claude-sonnet-4-5
   */
  private selectModelForTask(requiresDesktop?: boolean): typeof BROWSER_TASK_MODEL {
    if (requiresDesktop === true) {
      this.logger.debug('Selected DESKTOP_TASK_MODEL (qwen3-vl-32b) for desktop task');
      return DESKTOP_TASK_MODEL;
    }

    if (requiresDesktop === false) {
      this.logger.debug('Selected BROWSER_TASK_MODEL (fara-7b) for browser task');
      return BROWSER_TASK_MODEL;
    }

    // Fallback for unspecified execution surface
    this.logger.debug('Selected FALLBACK_TASK_MODEL (claude-sonnet-4-5) - execution surface not specified');
    return FALLBACK_TASK_MODEL;
  }

  /**
   * Dispatch a task to the agent system
   * Creates a task in bytebot-agent's database via API
   */
  async dispatchTask(request: TaskDispatchRequest): Promise<TaskDispatchResult> {
    if (!this.dispatchEnabled) {
      this.logger.warn('Task dispatch disabled, skipping');
      return { success: false, error: 'Task dispatch disabled' };
    }

    const attempt = request.attempt || 1;
    const idempotencyKey = this.generateIdempotencyKey(
      request.goalRunId,
      request.checklistItemId,
      attempt,
    );

    // Check for existing dispatch (idempotency)
    const existing = this.dispatchRecords.get(idempotencyKey);
    if (existing) {
      this.logger.debug(`Task already dispatched for ${idempotencyKey}, returning existing taskId: ${existing.taskId}`);
      return { success: true, taskId: existing.taskId };
    }

    // Phase 12: Select model based on execution surface
    const selectedModel = this.selectModelForTask(request.requiresDesktop);

      this.logger.log(
      `Dispatching task for checklist item ${request.checklistItemId} ` +
      `(attempt ${attempt}, model: ${selectedModel.title}, requiresDesktop: ${request.requiresDesktop}, surface: ${request.executionSurface})`,
    );

    try {
      // Build task payload for bytebot-agent
      // v1.0.1: Added required 'model' field for agent task schema
      // v1.0.2: Phase 4 - Forward requiresDesktop for execution surface constraints
      // v2.4.0: Added goalContext and previousStepResults for autonomous operation
      // Phase 12: Task-based model routing
      const taskPayload = {
        description: request.description,
        title: request.title,
        type: 'IMMEDIATE',
        priority: 'HIGH',
        // Phase 12: Model selected based on requiresDesktop
        model: selectedModel,
        // Workflow integration fields
        workspaceId: request.workspaceId,
        // Map checklistItemId to nodeRunId for agent tracking
        nodeRunId: request.checklistItemId,
        // Tool configuration
        allowedTools: request.allowedTools || [],
        highRiskTools: request.highRiskTools || [],
        gatewayToolsOnly: false,
        // Phase 4: Execution surface constraints - forward desktop requirement
        requiresDesktop: request.requiresDesktop ?? false,
        // PR5: ExecutionSurface propagation (end-to-end)
        executionSurface:
          request.executionSurface ??
          ((request.requiresDesktop ?? false) ? ExecutionSurface.DESKTOP : ExecutionSurface.TEXT_ONLY),
        // v2.4.0: Context propagation for autonomous operation
        // Provides goal context and previous step results to help agent proceed without asking
        goalContext: request.goalContext,
        previousStepResults: request.previousStepResults,
      };

      // Create task via agent API
      const response = await this.httpClient.post('/tasks', taskPayload);

      if (response.status === 201 || response.status === 200) {
        const task: AgentTask = response.data;

        // Record the dispatch
        const record: DispatchRecord = {
          idempotencyKey,
          taskId: task.id,
          goalRunId: request.goalRunId,
          checklistItemId: request.checklistItemId,
          status: 'DISPATCHED',
          createdAt: new Date(),
          // Phase 2.1: Initialize status check tracking
          lastSuccessfulCheck: new Date(),
          consecutiveCheckFailures: 0,
          // v1.1.0: Initialize 404 tolerance tracking
          notFoundCount: 0,
          // v1.2.0 Phase C: Initialize heartbeat health tracking
          isHeartbeatHealthy: true, // Assume healthy until first check
          consecutiveHeartbeatUnhealthy: 0,
        };
        this.dispatchRecords.set(idempotencyKey, record);

        // Emit activity event
        await this.emitActivityEvent(request.goalRunId, 'STEP_DISPATCHED', request.title, {
          checklistItemId: request.checklistItemId,
          taskId: task.id,
          attempt,
        });

        this.logger.log(`Task dispatched successfully: ${task.id} for item ${request.checklistItemId}`);
        return { success: true, taskId: task.id };
      }

      return { success: false, error: `Unexpected response status: ${response.status}` };
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      this.logger.error(`Failed to dispatch task for ${request.checklistItemId}: ${errorMsg}`);

      // Emit error activity
      await this.emitActivityEvent(request.goalRunId, 'ERROR', `Failed to dispatch step: ${request.title}`, {
        checklistItemId: request.checklistItemId,
        error: errorMsg,
        attempt,
      });

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Task status result with metadata for 404 handling
   * v1.1.0: Extended to support 404 tolerance
   */
  private async getTaskStatusWithMeta(taskId: string): Promise<{
    task: AgentTask | null;
    notFound: boolean;
    error?: string;
  }> {
    try {
      const response = await this.httpClient.get(`/tasks/${taskId}`);
      return { task: response.data, notFound: false };
    } catch (error: any) {
      // Differentiate 404 from other errors
      const status = error.response?.status;
      if (status === 404 || status === 410) {
        // 404 = Not Found, 410 = Gone (intentionally GC'd)
        return { task: null, notFound: true };
      }
      // Other errors (network, 500, etc.)
      this.logger.error(`Failed to get task status for ${taskId}: ${error.message}`);
      return { task: null, notFound: false, error: error.message };
    }
  }

  /**
   * Check task status in agent system
   * @deprecated Use getTaskStatusWithMeta for 404 awareness
   */
  async getTaskStatus(taskId: string): Promise<AgentTask | null> {
    const result = await this.getTaskStatusWithMeta(taskId);
    return result.task;
  }

  /**
   * v1.1.0: Fallback lookup - query agent API for task by nodeRunId
   * Used when agent API returns 404 (task GC'd before we could poll)
   *
   * Note: We can't access the Task table directly (it's in bytebot-agent DB).
   * Instead, we try an alternative agent API endpoint if available.
   */
  private async getTaskStatusFromDatabase(taskId: string): Promise<{
    status: AgentTaskStatus | null;
    result?: any;
    error?: string;
    source: 'database';
  }> {
    try {
      // Try alternative agent endpoint that may still have task info
      // The /tasks/by-id endpoint might have cached data or check database directly
      const response = await this.httpClient.get(`/tasks/${taskId}/status`, {
        timeout: 5000, // Short timeout for fallback
        validateStatus: (status) => status === 200 || status === 404,
      });

      if (response.status === 200 && response.data) {
        return {
          status: response.data.status as AgentTaskStatus,
          result: response.data.result,
          error: response.data.error || undefined,
          source: 'database',
        };
      }

      return { status: null, source: 'database' };
    } catch (error: any) {
      // Fallback lookup failed - this is expected, not an error
      this.logger.debug(`Database fallback lookup failed for ${taskId}: ${error.message}`);
      return { status: null, source: 'database' };
    }
  }

  /**
   * v1.1.0: Fallback lookup - check checklist item for completion
   * Last resort when both agent API and database fail
   */
  private async getTaskStatusFromChecklistItem(checklistItemId: string): Promise<{
    status: AgentTaskStatus | null;
    result?: any;
    error?: string;
    source: 'checklist';
  }> {
    try {
      const item = await this.prisma.checklistItem.findUnique({
        where: { id: checklistItemId },
        select: {
          status: true,
          actualOutcome: true,
        },
      });

      if (item) {
        // Map checklist status to agent task status
        let mappedStatus: AgentTaskStatus | null = null;
        if (item.status === 'COMPLETED') {
          mappedStatus = 'COMPLETED';
        } else if (item.status === 'FAILED') {
          mappedStatus = 'FAILED';
        }

        if (mappedStatus) {
          return {
            status: mappedStatus,
            result: item.actualOutcome,
            source: 'checklist',
          };
        }
      }

      return { status: null, source: 'checklist' };
    } catch (error: any) {
      this.logger.debug(`Checklist fallback lookup failed for ${checklistItemId}: ${error.message}`);
      return { status: null, source: 'checklist' };
    }
  }

  /**
   * Poll for task completion and update checklist items
   * Runs every 5 seconds (configurable)
   *
   * v1.1.1: DB transient error handling with backoff
   * v1.1.0: Implements 404 tolerance with grace window and fallback lookups
   *
   * When a 404 is received:
   * 1. Enter grace window (don't fail immediately)
   * 2. Attempt fallback lookups (database, checklist item)
   * 3. Only after grace expires with no resolution, mark as INFRA_FAILED
   * 4. INFRA_FAILED triggers step retry, NOT replan (saves replan attempts)
   */
  @Cron(CronExpression.EVERY_5_SECONDS)
  async pollTaskCompletions(): Promise<void> {
    if (!this.dispatchEnabled) return;

    // v1.1.1: Skip if in DB backoff
    if (this.dbTransientService.isInBackoff()) {
      this.logger.debug(
        `Task polling skipped - DB backoff (${Math.round(this.dbTransientService.getBackoffRemainingMs() / 1000)}s remaining)`,
      );
      return;
    }

    const inFlightRecords = Array.from(this.dispatchRecords.values())
      .filter(r => r.status === 'DISPATCHED' || r.status === 'RUNNING' || r.status === 'WAITING_USER');

    if (inFlightRecords.length === 0) return;

    this.logger.debug(`Polling ${inFlightRecords.length} in-flight tasks`);

    for (const record of inFlightRecords) {
      try {
        // v1.1.0: Use getTaskStatusWithMeta for 404 awareness
        const result = await this.getTaskStatusWithMeta(record.taskId);

        // Handle 404/410 - task not found (may have been GC'd)
        if (result.notFound) {
          await this.handle404WithGraceWindow(record);
          continue;
        }

        // Handle other errors (network, 500, etc.)
        if (!result.task && result.error) {
          record.consecutiveCheckFailures++;
          this.dispatchRecords.set(record.idempotencyKey, record);

          if (record.consecutiveCheckFailures <= STATUS_CHECK_FAILURE_THRESHOLD) {
            this.logger.warn(
              `Transient status check failure for task ${record.taskId} ` +
                `(${record.consecutiveCheckFailures}/${STATUS_CHECK_FAILURE_THRESHOLD}): ${result.error}`,
            );
            continue;
          }

          // Extended failure window exceeded
          const timeSinceLastSuccess = record.lastSuccessfulCheck
            ? Date.now() - record.lastSuccessfulCheck.getTime()
            : Date.now() - record.createdAt.getTime();

          if (timeSinceLastSuccess > STATUS_CHECK_FAILURE_WINDOW_MS) {
            this.logger.error(
              `Task ${record.taskId} unreachable for ${Math.round(timeSinceLastSuccess / 1000)}s ` +
                `(${record.consecutiveCheckFailures} consecutive failures)`,
            );

            // Mark as infrastructure failure (retry, don't replan)
            await this.markAsInfrastructureFailure(record, 'Agent unreachable');
          }
          continue;
        }

        // Task found - process normally
        const task = result.task!;

        // Clear 404 grace window tracking (task is reachable again)
        if (record.notFoundGraceStartedAt) {
          this.logger.log(`Task ${record.taskId} reappeared after 404, clearing grace window`);
          record.notFoundGraceStartedAt = undefined;
          record.notFoundCount = 0;
        }

        // Status check succeeded - reset failure tracking
        record.consecutiveCheckFailures = 0;
        record.lastSuccessfulCheck = new Date();

        // v1.2.0 Phase C: Update heartbeat health from task controller
        // This runs in parallel with status polling for comprehensive health tracking
        await this.updateHeartbeatHealth(record);

        // Update record status based on task status
        if (task.status === 'RUNNING' && record.status === 'DISPATCHED') {
          record.status = 'RUNNING';
          this.dispatchRecords.set(record.idempotencyKey, record);

          await this.emitActivityEvent(record.goalRunId, 'STEP_STARTED', task.title || 'Step started', {
            checklistItemId: record.checklistItemId,
            taskId: record.taskId,
          });
        }

        // Handle completion
        if (task.status === 'COMPLETED') {
          await this.handleTaskCompleted(record, task.result, task.title);
        }

        // Handle semantic failure (task actually failed, not infra issue)
        if (task.status === 'FAILED' || task.status === 'CANCELLED') {
          await this.handleTaskFailed(record, task.error, task.title, 'SEMANTIC');
        }

        // v2.4.0: Handle NEEDS_HELP status - task paused for user input
        // Clean up TaskDesktop resource since task is no longer actively processing
        if (task.status === 'NEEDS_HELP') {
          // Stark Fix (Atom 3): once a dispatch record is WAITING_USER, do not re-emit/redo NEEDS_HELP handling.
          if (record.status !== 'WAITING_USER') {
            await this.handleTaskNeedsHelp(record, task);
          }
        }
      } catch (error: any) {
        this.logger.error(`Error polling task ${record.taskId}: ${error.message}`);
      }
    }
  }

  /**
   * v1.1.0: Handle 404 response with grace window and fallback lookups
   *
   * Critical design principle: 404 does NOT mean failure.
   * The task may have completed and been GC'd before we could poll.
   * We must check fallback sources before declaring failure.
   */
  private async handle404WithGraceWindow(record: DispatchRecord): Promise<void> {
    const now = new Date();
    record.notFoundCount++;

    // Start grace window if not already started
    if (!record.notFoundGraceStartedAt) {
      record.notFoundGraceStartedAt = now;
      this.logger.warn(
        `Task ${record.taskId} not found (404), starting grace window (${this.notFoundGraceMs}ms)`,
      );
    }

    // Check how long we've been in grace window
    const graceElapsedMs = now.getTime() - record.notFoundGraceStartedAt.getTime();

    // Attempt fallback lookups
    this.logger.debug(`Task ${record.taskId} 404 - attempting fallback lookups (grace: ${Math.round(graceElapsedMs / 1000)}s)`);

    // Fallback 1: Check database for task status
    const dbResult = await this.getTaskStatusFromDatabase(record.taskId);
    if (dbResult.status) {
      this.logger.log(`Task ${record.taskId} found in database via fallback: ${dbResult.status}`);

      if (dbResult.status === 'COMPLETED') {
        await this.handleTaskCompleted(record, dbResult.result, undefined, 'database');
        return;
      }
      if (dbResult.status === 'FAILED' || dbResult.status === 'CANCELLED') {
        await this.handleTaskFailed(record, dbResult.error, undefined, 'SEMANTIC');
        return;
      }
      // Task still running in DB but 404 from API - possible race, continue waiting
    }

    // Fallback 2: Check checklist item status
    const checklistResult = await this.getTaskStatusFromChecklistItem(record.checklistItemId);
    if (checklistResult.status) {
      this.logger.log(`Task ${record.taskId} found in checklist via fallback: ${checklistResult.status}`);

      if (checklistResult.status === 'COMPLETED') {
        // Already marked complete by some other path
        record.status = 'COMPLETED';
        record.completedAt = now;
        this.dispatchRecords.set(record.idempotencyKey, record);
        return;
      }
      if (checklistResult.status === 'FAILED') {
        // Already marked failed by some other path
        record.status = 'FAILED';
        record.completedAt = now;
        this.dispatchRecords.set(record.idempotencyKey, record);
        return;
      }
    }

    // No resolution found - check if grace window expired
    if (graceElapsedMs >= this.notFoundGraceMs) {
      this.logger.error(
        `Task ${record.taskId} not found after ${Math.round(graceElapsedMs / 1000)}s grace window ` +
          `(${record.notFoundCount} 404s), marking as infrastructure failure`,
      );

      // Mark as infrastructure failure - triggers retry, not replan
      await this.markAsInfrastructureFailure(
        record,
        `Task not found after ${Math.round(graceElapsedMs / 1000)}s (404 x${record.notFoundCount})`,
      );
      return;
    }

    // Still within grace window - update record and wait
    this.dispatchRecords.set(record.idempotencyKey, record);
    this.logger.debug(
      `Task ${record.taskId} grace window: ${Math.round((this.notFoundGraceMs - graceElapsedMs) / 1000)}s remaining`,
    );
  }

  /**
   * v1.1.0: Handle task completion (from any source)
   */
  private async handleTaskCompleted(
    record: DispatchRecord,
    result?: any,
    title?: string,
    source: string = 'agent',
  ): Promise<void> {
    record.status = 'COMPLETED';
    record.completedAt = new Date();
    record.failureType = undefined;
    this.dispatchRecords.set(record.idempotencyKey, record);

    await this.updateChecklistItemStatus(record.checklistItemId, 'COMPLETED', result);

    await this.emitActivityEvent(record.goalRunId, 'STEP_COMPLETED', title || 'Step completed', {
      checklistItemId: record.checklistItemId,
      taskId: record.taskId,
      result,
      source,
    });

    this.logger.log(`Task ${record.taskId} completed for item ${record.checklistItemId} (source: ${source})`);
  }

  /**
   * v1.1.0: Handle task failure with failure type classification
   *
   * Critical: failureType determines replan behavior:
   * - SEMANTIC: Task actually failed (wrong output, verification failed) → REPLAN
   * - INFRASTRUCTURE: Infra issue (404, timeout, network) → RETRY (don't consume replan)
   */
  private async handleTaskFailed(
    record: DispatchRecord,
    error?: string,
    title?: string,
    failureType: FailureType = 'UNKNOWN',
  ): Promise<void> {
    record.status = 'FAILED';
    record.completedAt = new Date();
    record.failureType = failureType;
    this.dispatchRecords.set(record.idempotencyKey, record);

    // v1.1.0: Store failure type in actualOutcome for orchestrator to read
    const errorWithType = failureType === 'INFRASTRUCTURE'
      ? `[INFRA] ${error || 'Infrastructure failure'}`
      : error || 'Task failed';

    await this.updateChecklistItemStatus(record.checklistItemId, 'FAILED', undefined, errorWithType);

    await this.emitActivityEvent(record.goalRunId, 'ERROR', `Step failed: ${title || 'Unknown'}`, {
      checklistItemId: record.checklistItemId,
      taskId: record.taskId,
      error: errorWithType,
      failureType,
    });

    this.logger.warn(
      `Task ${record.taskId} failed for item ${record.checklistItemId}: ${errorWithType} (type: ${failureType})`,
    );
  }

  /**
   * v2.4.0: Handle task transitioned to NEEDS_HELP status
   *
   * When a task asks for user help (e.g., Claude asks for clarification):
   * 1. Notify task controller to clean up the TaskDesktop resource
   * 2. The task is paused, not failed - user can provide input via UI
   * 3. Emit activity event for visibility
   *
   * Note: This is distinct from failure - the task can continue after user input.
   * The TaskDesktop cleanup prevents resource wastage during the wait.
   */
  private async handleTaskNeedsHelp(record: DispatchRecord, task: AgentTask): Promise<void> {
    // Stark Fix (Atom 3): NEEDS_HELP must be idempotent (no 5s spam loop).
    // Make NEEDS_HELP a durable state transition:
    // - dispatch record → WAITING_USER (in-memory hotfix)
    // - checklist item → BLOCKED (durable)
    // - goal run phase → WAITING_USER_INPUT (durable)
    // Side effects (activity, outbox) must happen once only, guarded by the durable transition.
    if (record.status === 'WAITING_USER') return;

    const promptKind = task.requiresDesktop
      ? UserPromptKind.DESKTOP_TAKEOVER
      : UserPromptKind.TEXT_CLARIFICATION;

    const appBaseUrl = this.configService.get<string>('APP_BASE_URL', 'https://app.bytebot.ai');
    const desktopTakeoverLink =
      promptKind === UserPromptKind.DESKTOP_TAKEOVER
        ? `${appBaseUrl}/tasks/${record.taskId}`
        : null;

    const goalRunTenant = await this.prisma.goalRun.findUnique({
      where: { id: record.goalRunId },
      select: { tenantId: true, executionEngine: true },
    });
    if (!goalRunTenant?.tenantId) {
      throw new Error(`GoalRun ${record.goalRunId} not found (tenantId missing)`);
    }

    const isTemporal = goalRunTenant.executionEngine === GoalRunExecutionEngine.TEMPORAL_WORKFLOW;
    const stepKey =
      isTemporal && record.checklistItemId.startsWith(`${record.goalRunId}-`)
        ? record.checklistItemId.slice(record.goalRunId.length + 1)
        : record.checklistItemId;

    // Durable idempotency (restart-safe):
    // If an OPEN prompt already exists for this run+step+kind, treat NEEDS_HELP as already handled.
    // This prevents repeated "needs help" logs/spam after process restarts (no in-memory dependency).
    const promptDedupeKey = this.userPromptService.buildDedupeKey(
      record.goalRunId,
      stepKey,
      promptKind,
    );
    const existingPrompt = await this.prisma.userPrompt.findUnique({
      where: { dedupeKey: promptDedupeKey },
      select: { id: true, status: true, kind: true, dedupeKey: true },
    });

    if (existingPrompt?.status === UserPromptStatus.OPEN) {
      // Best-effort: ensure legacy checklist item is durably marked BLOCKED and linked to the prompt.
      // This enables operators to derive "already handled" entirely from DB state.
      if (!isTemporal) {
        await this.transitionChecklistItemToBlockedWaitingUser(record, task.title, {
          promptId: existingPrompt.id,
          promptKind: existingPrompt.kind,
          promptDedupeKey: existingPrompt.dedupeKey,
        });

        try {
          const existingItem = await this.prisma.checklistItem.findUnique({
            where: { id: record.checklistItemId },
            select: { status: true, blockedByPromptId: true },
          });

          if (existingItem?.status === ChecklistItemStatus.BLOCKED && !existingItem.blockedByPromptId) {
            await this.prisma.checklistItem.updateMany({
              where: { id: record.checklistItemId, blockedByPromptId: null },
              data: {
                blockedByPromptId: existingPrompt.id,
                blockedReason: 'NEEDS_HELP',
                blockedAt: new Date(),
              },
            });
          }
        } catch {
          // ignore repair failures; we still stop spam via record.status
        }
      }

      await this.transitionGoalRunToWaitingUserInput(record.goalRunId);

      // Best-effort: ensure outbox notification exists (idempotent via dedupe key).
      try {
        await this.outboxService.enqueueOnce({
          dedupeKey: existingPrompt.dedupeKey,
          aggregateId: record.goalRunId,
          eventType: 'user_prompt.created',
          payload: {
            promptId: existingPrompt.id,
            goalRunId: record.goalRunId,
            tenantId: goalRunTenant.tenantId,
            checklistItemId: isTemporal ? null : record.checklistItemId,
            stepKey: isTemporal ? stepKey : null,
            taskId: record.taskId,
            kind: existingPrompt.kind,
            stepDescription: task.title || null,
            links: {
              desktopTakeover: desktopTakeoverLink,
            },
          },
        });
      } catch {
        // ignore; outbox publisher/reconciler will retry later
      }

      // In-memory hotfix: stop per-poll spam immediately.
      record.status = 'WAITING_USER';
      this.dispatchRecords.set(record.idempotencyKey, record);
      return;
    }

    this.logger.log(`Task ${record.taskId} needs user help for item ${record.checklistItemId}`);

    const prompt = isTemporal
      ? await this.userPromptService.ensureOpenPromptForStepKey({
          tenantId: goalRunTenant.tenantId,
          goalRunId: record.goalRunId,
          stepKey,
          kind: promptKind,
          payload: {
            goalRunId: record.goalRunId,
            stepKey,
            taskId: record.taskId,
            workspaceId: task.workspaceId ?? null,
            requiresDesktop: task.requiresDesktop ?? false,
            title: task.title || null,
            result: task.result ?? null,
            error: task.error ?? null,
            reason: 'Task requires user input to continue',
            links: {
              desktopTakeover: desktopTakeoverLink,
            },
          },
        })
      : await this.userPromptService.ensureOpenPromptForStep({
          tenantId: goalRunTenant.tenantId,
          goalRunId: record.goalRunId,
          checklistItemId: record.checklistItemId,
          kind: promptKind,
          payload: {
            goalRunId: record.goalRunId,
            checklistItemId: record.checklistItemId,
            taskId: record.taskId,
            workspaceId: task.workspaceId ?? null,
            requiresDesktop: task.requiresDesktop ?? false,
            title: task.title || null,
            result: task.result ?? null,
            error: task.error ?? null,
            reason: 'Task requires user input to continue',
            links: {
              desktopTakeover: desktopTakeoverLink,
            },
          },
        });

    const stepTransitioned = isTemporal
      ? false
      : await this.transitionChecklistItemToBlockedWaitingUser(record, task.title, {
          promptId: prompt.id,
          promptKind: prompt.kind,
          promptDedupeKey: prompt.dedupeKey,
        });
    const phaseTransitioned = await this.transitionGoalRunToWaitingUserInput(record.goalRunId);

    await this.outboxService.enqueueOnce({
      dedupeKey: prompt.dedupeKey,
      aggregateId: record.goalRunId,
      eventType: 'user_prompt.created',
      payload: {
        promptId: prompt.id,
        goalRunId: record.goalRunId,
        tenantId: goalRunTenant.tenantId,
        checklistItemId: isTemporal ? null : record.checklistItemId,
        stepKey: isTemporal ? stepKey : null,
        taskId: record.taskId,
        kind: prompt.kind,
        stepDescription: task.title || null,
        links: {
          desktopTakeover: desktopTakeoverLink,
        },
      },
    });

    // In-memory durable-ish transition (prevents repeated poll-tick logs/side-effects within this process).
    // We only mark WAITING_USER after prompt/outbox succeeded so a transient failure can retry.
    record.status = 'WAITING_USER';
    this.dispatchRecords.set(record.idempotencyKey, record);

    // Only emit "needs help" signals on the first durable transition.
    if (!stepTransitioned && !phaseTransitioned) return;

    await this.emitActivityEvent(
      record.goalRunId,
      'USER_PROMPT_CREATED',
      `Waiting for user input: ${task.title || 'Step paused'}`,
      {
        checklistItemId: record.checklistItemId,
        taskId: record.taskId,
        promptId: prompt.id,
        promptKind: prompt.kind,
        dedupeKey: prompt.dedupeKey,
      },
    );

    if (prompt.kind === UserPromptKind.TEXT_CLARIFICATION) {
      // Policy: TEXT_CLARIFICATION -> cleanup OK.
      // This releases the desktop pod back to the pool while waiting for user input.
      try {
        await this.taskControllerClient.delete(`/api/v1/tasks/${record.taskId}/desktop`);
        this.logger.log(`TaskDesktop cleanup requested for task ${record.taskId}`);
      } catch (error: any) {
        this.logger.warn(`Failed to cleanup TaskDesktop for task ${record.taskId}: ${error.message}`);
      }
    } else {
      // Policy: DESKTOP_TAKEOVER -> preserve desktop + extend keepalive TTL.
      // Best effort: if the desktop is task-scoped, extend timeout while user takes over.
      try {
        await this.taskControllerClient.post(`/api/v1/tasks/${record.taskId}/extend`, {
          additionalMinutes: 60,
        });
        this.logger.log(`TaskDesktop timeout extended for task ${record.taskId} (desktop takeover)`);
      } catch (error: any) {
        this.logger.warn(`Failed to extend TaskDesktop timeout for task ${record.taskId}: ${error.message}`);
      }
    }

    await this.emitActivityEvent(record.goalRunId, 'STEP_NEEDS_HELP', `Waiting for input: ${task.title || 'Step paused'}`, {
      checklistItemId: record.checklistItemId,
      taskId: record.taskId,
      reason: 'Task requires user input to continue',
    });
  }

  /**
   * Stark Fix (Atom 3): Atomic, idempotent transition for NEEDS_HELP handling.
   *
   * Uses a single UPDATE with WHERE status IN (...) so concurrent pollers can't double-transition.
   * Side effects are only emitted when the transition succeeds (count > 0).
   */
  private async transitionChecklistItemToBlockedWaitingUser(
    record: DispatchRecord,
    title?: string,
    prompt?: { promptId: string; promptKind: string; promptDedupeKey: string },
  ): Promise<boolean> {
    const blockedAt = new Date();
    const outcome = JSON.stringify(
      {
        blockedReason: 'WAITING_USER_INPUT',
        source: 'AGENT_NEEDS_HELP',
        taskId: record.taskId,
        title: title || null,
        ...(
          prompt
            ? {
                promptId: prompt.promptId,
                promptKind: prompt.promptKind,
                promptDedupeKey: prompt.promptDedupeKey,
              }
            : {}
        ),
      },
      null,
      2,
    );

    const result = await this.dbTransientService.withTransientGuard(
      async () => {
        return await this.prisma.checklistItem.updateMany({
          where: {
            id: record.checklistItemId,
            status: {
              in: [ChecklistItemStatus.IN_PROGRESS, ChecklistItemStatus.PENDING],
            },
          },
          data: {
            status: ChecklistItemStatus.BLOCKED,
            blockedByPromptId: prompt?.promptId ?? null,
            blockedReason: 'NEEDS_HELP',
            blockedAt,
            completedAt: null,
            actualOutcome: outcome,
          },
        });
      },
      `TaskDispatch.transitionChecklistItemToBlockedWaitingUser.${record.checklistItemId}`,
      {
        onTransientError: (err, backoffMs) => {
          this.logger.warn(
            `Transient error blocking checklist item ${record.checklistItemId}, will retry ` +
              `(backoff: ${Math.round(backoffMs / 1000)}s): ${err.message}`,
          );
        },
      },
    );

    return (result?.count || 0) > 0;
  }

  private async transitionGoalRunToWaitingUserInput(goalRunId: string): Promise<boolean> {
    const goalRun = await this.dbTransientService.withTransientGuard(
      async () => {
        return await this.prisma.goalRun.findUnique({
          where: { id: goalRunId },
          select: { phase: true },
        });
      },
      `TaskDispatch.transitionGoalRunToWaitingUserInput.read.${goalRunId}`,
      {
        onTransientError: (err, backoffMs) => {
          this.logger.debug(
            `Transient error reading goal run ${goalRunId} before phase transition ` +
              `(backoff: ${Math.round(backoffMs / 1000)}s): ${err.message}`,
          );
        },
      },
    );

    if (!goalRun) return false;

    const updated = await this.dbTransientService.withTransientGuard(
      async () => {
        return await this.prisma.goalRun.updateMany({
          where: {
            id: goalRunId,
            phase: {
              in: [GoalRunPhase.EXECUTING, GoalRunPhase.CONTROLLING_DESKTOP],
            },
          },
          data: { phase: GoalRunPhase.WAITING_USER_INPUT },
        });
      },
      `TaskDispatch.transitionGoalRunToWaitingUserInput.update.${goalRunId}`,
      {
        onTransientError: (err, backoffMs) => {
          this.logger.debug(
            `Transient error updating goal run ${goalRunId} phase ` +
              `(backoff: ${Math.round(backoffMs / 1000)}s): ${err.message}`,
          );
        },
      },
    );

    if ((updated?.count || 0) > 0) {
      this.eventEmitter.emit('goal-run.phase-changed', {
        goalRunId,
        previousPhase: goalRun.phase,
        newPhase: GoalRunPhase.WAITING_USER_INPUT,
      });
      return true;
    }

    return false;
  }

  /**
   * v1.1.0: Mark task as infrastructure failure
   *
   * Infrastructure failures (404, timeout, unreachable) should:
   * 1. NOT consume replan attempts
   * 2. Trigger step retry with backoff
   * 3. Be clearly distinguished from semantic failures
   */
  private async markAsInfrastructureFailure(record: DispatchRecord, error: string): Promise<void> {
    record.status = 'INFRA_FAILED';
    record.completedAt = new Date();
    record.failureType = 'INFRASTRUCTURE';
    this.dispatchRecords.set(record.idempotencyKey, record);

    // v1.1.0: Mark with [INFRA] prefix so orchestrator knows not to replan
    const infraError = `[INFRA] ${error}`;

    await this.updateChecklistItemStatus(record.checklistItemId, 'FAILED', undefined, infraError);

    await this.emitActivityEvent(record.goalRunId, 'INFRA_ERROR', `Infrastructure failure: ${error}`, {
      checklistItemId: record.checklistItemId,
      taskId: record.taskId,
      error: infraError,
      failureType: 'INFRASTRUCTURE',
      recoverable: true,
    });

    this.logger.error(
      `Task ${record.taskId} marked as INFRA_FAILED for item ${record.checklistItemId}: ${error}`,
    );
  }

  /**
   * Update checklist item status in orchestrator database
   * v1.1.1: Wrapped in transient guard for DB resilience
   */
  private async updateChecklistItemStatus(
    itemId: string,
    status: 'COMPLETED' | 'FAILED' | 'SKIPPED',
    result?: any,
    error?: string,
  ): Promise<void> {
    await this.dbTransientService.withTransientGuard(
      async () => {
        await this.prisma.checklistItem.update({
          where: { id: itemId },
          data: {
            status,
            actualOutcome: result ? JSON.stringify(result) : undefined,
            completedAt: new Date(),
            // Store error in actualOutcome if failed
            ...(status === 'FAILED' && error ? { actualOutcome: `Error: ${error}` } : {}),
          },
        });
      },
      `TaskDispatch.updateChecklistItemStatus.${itemId}`,
      {
        onTransientError: (err, backoffMs) => {
          this.logger.warn(
            `Transient error updating checklist item ${itemId}, will retry ` +
            `(backoff: ${Math.round(backoffMs / 1000)}s): ${err.message}`,
          );
        },
        onNonTransientError: (err) => {
          this.logger.error(`Failed to update checklist item ${itemId}: ${err.message}`);
        },
      },
    );
  }

  /**
   * Emit activity event for UI updates
   * v1.1.1: Wrapped in transient guard for DB resilience
   */
  private async emitActivityEvent(
    goalRunId: string,
    eventType: string,
    title: string,
    details?: any,
  ): Promise<void> {
    const checklistItemId =
      typeof details?.checklistItemId === 'string' ? details.checklistItemId : undefined;
    const planVersionId =
      typeof details?.planVersionId === 'string' ? details.planVersionId : undefined;
    const workflowNodeId =
      typeof details?.workflowNodeId === 'string' ? details.workflowNodeId : undefined;

    await this.dbTransientService.withTransientGuard(
      async () => {
        // Check if goal run exists first
        const goalRun = await this.prisma.goalRun.findUnique({
          where: { id: goalRunId },
        });

        if (!goalRun) {
          this.logger.warn(`Goal run ${goalRunId} not found, skipping activity event`);
          return;
        }

        await this.prisma.activityEvent.create({
          data: {
            goalRunId,
            eventType,
            title,
            description: details ? JSON.stringify(details) : undefined,
            details: details || {},
            checklistItemId,
            planVersionId,
            workflowNodeId,
          },
        });

        // Emit event for real-time updates
        this.eventEmitter.emit('goalrun.activity', {
          goalRunId,
          eventType,
          title,
          details,
        });
      },
      `TaskDispatch.emitActivityEvent.${goalRunId}`,
      {
        onTransientError: (err, backoffMs) => {
          // Activity events are non-critical, just log
          this.logger.debug(
            `Transient error emitting activity event for ${goalRunId}, skipped: ${err.message}`,
          );
        },
        onNonTransientError: (err) => {
          this.logger.error(`Failed to emit activity event: ${err.message}`);
        },
      },
    );
  }

  /**
   * Recover in-flight dispatches on startup
   * v1.1.1: Enhanced recovery with actual task lookup and record creation
   *
   * This is critical for the restart grace window to work correctly:
   * 1. Query all IN_PROGRESS checklist items from DB
   * 2. For each, look up the corresponding task in the agent system
   * 3. Create dispatch records so polling can resume
   * 4. This allows the orchestrator to properly reconcile state after restart
   */
  private async recoverInFlightDispatches(): Promise<void> {
    // v1.1.1: Wrap in transient guard for DB resilience during startup
    const inProgressItems = await this.dbTransientService.withTransientGuard(
      async () => {
        return await this.prisma.checklistItem.findMany({
          where: {
            status: 'IN_PROGRESS',
          },
          include: {
            planVersion: {
              include: {
                goalRun: true,
              },
            },
          },
        });
      },
      'TaskDispatch.recoverInFlightDispatches',
      {
        skipIfInBackoff: false, // Always try on startup
        onTransientError: (err, backoffMs) => {
          this.logger.warn(
            `DB not ready during startup recovery, will retry in next poll cycle ` +
            `(backoff: ${Math.round(backoffMs / 1000)}s): ${err.message}`,
          );
        },
      },
    );

    if (!inProgressItems) {
      this.logger.warn('Could not recover in-flight dispatches - DB unavailable');
      return;
    }

    this.logger.log(`Recovering ${inProgressItems.length} in-progress checklist items`);

    // For each in-progress item, try to find the corresponding task in agent system
    for (const item of inProgressItems) {
      if (!item.planVersion?.goalRun) continue;

      const goalRunId = item.planVersion.goalRun.id;
      const idempotencyKey = this.generateIdempotencyKey(goalRunId, item.id, 1);

      // Skip if we already have a record (shouldn't happen, but safety check)
      if (this.dispatchRecords.has(idempotencyKey)) {
        this.logger.debug(`Dispatch record already exists for item ${item.id}`);
        continue;
      }

      try {
        // Try to find the task by querying the agent API with nodeRunId
        // The agent stores nodeRunId = checklistItemId when we create tasks
        const taskResponse = await this.httpClient.get('/tasks', {
          params: { nodeRunId: item.id },
          timeout: 5000,
          validateStatus: (status) => status === 200 || status === 404,
        });

        if (taskResponse.status === 200 && taskResponse.data?.length > 0) {
          const task = taskResponse.data[0]; // Most recent task for this nodeRunId

          // Create a recovery record
          const record: DispatchRecord = {
            idempotencyKey,
            taskId: task.id,
            goalRunId,
            checklistItemId: item.id,
            status: task.status === 'RUNNING' ? 'RUNNING' : 'DISPATCHED',
            createdAt: new Date(task.createdAt || Date.now()),
            lastSuccessfulCheck: new Date(),
            consecutiveCheckFailures: 0,
            notFoundCount: 0,
            // v1.2.0 Phase C: Initialize heartbeat health tracking
            isHeartbeatHealthy: true,
            consecutiveHeartbeatUnhealthy: 0,
          };
          this.dispatchRecords.set(idempotencyKey, record);

          this.logger.log(
            `Recovered dispatch record for item ${item.id} → task ${task.id} (${task.status})`,
          );
        } else {
          // No task found - create a placeholder record that will trigger re-dispatch
          // or be cleaned up by the next poll cycle
          this.logger.warn(
            `No task found for in-progress item ${item.id} - may need re-dispatch`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to recover task for item ${item.id}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Recovery complete: ${this.dispatchRecords.size} dispatch records loaded`,
    );
  }

  /**
   * Handle workflow node ready event
   * This integrates with the existing orchestrator-loop executeStepViaWorkflow
   */
  @OnEvent('workflow.node-ready')
  async handleNodeReady(payload: {
    workflowRunId: string;
    nodeId: string;
    goalRunId: string;
    checklistItemId: string;
  }): Promise<void> {
    this.logger.log(`Node ready event received for item ${payload.checklistItemId}`);

    // Get the checklist item details
    const item = await this.prisma.checklistItem.findUnique({
      where: { id: payload.checklistItemId },
      include: {
        planVersion: {
          include: {
            goalRun: true,
          },
        },
      },
    });

    if (!item || !item.planVersion?.goalRun) {
      this.logger.error(`Checklist item ${payload.checklistItemId} not found`);
      return;
    }

    // Get workspace ID from goal run
    const goalRun = item.planVersion.goalRun;
    const workspaceId = (goalRun as any).workspaceId || undefined;

    // v2.4.0: Get goal context and previous step results for autonomous operation
    const goalContext = (goalRun as any).goal as string;

    // Get completed previous steps from the same plan version
    const completedItems = await this.prisma.checklistItem.findMany({
      where: {
        planVersionId: item.planVersionId,
        status: 'COMPLETED',
        order: { lt: item.order }, // Only items before this one
      },
      orderBy: { order: 'asc' },
      select: {
        description: true,
        actualOutcome: true,
        order: true,
      },
    });

    // Build previous step results summary with context summarization
    // v2.4.1: Implements hierarchical summarization for long histories
    let previousStepResults = this.buildPreviousStepResults(completedItems);

    // PR5: Inject resolved user prompt answers for this step into agent context.
    // This prevents “answer loss” when an EXECUTE step is unblocked by a prompt resolution.
    const resolvedPromptsForItem = await this.prisma.userPrompt.findMany({
      where: {
        checklistItemId: item.id,
        status: UserPromptStatus.RESOLVED,
      },
      orderBy: { resolvedAt: 'desc' },
      take: 3,
      select: {
        id: true,
        kind: true,
        answers: true,
        resolvedAt: true,
      },
    });

    if (resolvedPromptsForItem.length > 0) {
      const formatted = resolvedPromptsForItem
        .map((p) => {
          const ts = p.resolvedAt ? ` @ ${p.resolvedAt.toISOString()}` : '';
          return `- ${p.kind} (${p.id})${ts}: ${JSON.stringify(p.answers)}`;
        })
        .join('\n');

      previousStepResults = [previousStepResults, `User-provided answers for this step:\n${formatted}`]
        .filter((s) => !!s && String(s).trim().length > 0)
        .join('\n\n');
    }

    // v2.4.1: Structured logging for context propagation debugging
    this.logger.log({
      message: 'Dispatching task with context',
      goalRunId: payload.goalRunId,
      checklistItemId: payload.checklistItemId,
      stepOrder: item.order,
      hasGoalContext: !!goalContext,
      goalContextLength: goalContext?.length || 0,
      previousStepsCount: completedItems.length,
      previousStepsWithOutcome: completedItems.filter((ci) => ci.actualOutcome).length,
      workspaceId: workspaceId || null,
      requiresDesktop: item.requiresDesktop,
      executionSurface: item.executionSurface,
    });

    // Dispatch the task
    await this.dispatchTask({
      goalRunId: payload.goalRunId,
      checklistItemId: payload.checklistItemId,
      planVersionId: item.planVersionId,
      workspaceId,
      title: item.description.slice(0, 100),
      description: item.description,
      expectedOutcome: item.expectedOutcome || undefined,
      allowedTools: item.suggestedTools || [],
      requiresDesktop: item.requiresDesktop,
      executionSurface: item.executionSurface,
      // v2.4.0: Context propagation for autonomous operation
      goalContext,
      previousStepResults,
    });
  }

  /**
   * Get dispatch statistics
   */
  getStats(): { total: number; dispatched: number; running: number; completed: number; failed: number } {
    const records = Array.from(this.dispatchRecords.values());
    return {
      total: records.length,
      dispatched: records.filter(r => r.status === 'DISPATCHED').length,
      running: records.filter(r => r.status === 'RUNNING').length,
      completed: records.filter(r => r.status === 'COMPLETED').length,
      failed: records.filter(r => r.status === 'FAILED').length,
    };
  }

  /**
   * Phase 2.1: Get status check health for a checklist item
   * Returns info about whether we can reliably check task status
   */
  getStatusCheckHealth(checklistItemId: string): {
    hasActiveDispatch: boolean;
    lastSuccessfulCheck?: Date;
    consecutiveFailures: number;
    isHealthy: boolean;
  } {
    // Find dispatch record for this checklist item
    const record = Array.from(this.dispatchRecords.values()).find(
      r => r.checklistItemId === checklistItemId && (r.status === 'DISPATCHED' || r.status === 'RUNNING'),
    );

    if (!record) {
      return {
        hasActiveDispatch: false,
        consecutiveFailures: 0,
        isHealthy: true,
      };
    }

    const isHealthy = record.consecutiveCheckFailures < STATUS_CHECK_FAILURE_THRESHOLD;

    return {
      hasActiveDispatch: true,
      lastSuccessfulCheck: record.lastSuccessfulCheck,
      consecutiveFailures: record.consecutiveCheckFailures,
      isHealthy,
    };
  }

  /**
   * Phase 2.2: Get effective "last progress" time for timeout calculations
   * Uses lastSuccessfulCheck if available, otherwise falls back to createdAt
   */
  getLastProgressTime(checklistItemId: string): Date | null {
    const record = Array.from(this.dispatchRecords.values()).find(
      r => r.checklistItemId === checklistItemId && (r.status === 'DISPATCHED' || r.status === 'RUNNING'),
    );

    if (!record) return null;

    // Return the more recent of lastSuccessfulCheck or createdAt
    return record.lastSuccessfulCheck || record.createdAt;
  }

  /**
   * v1.2.0 Phase C: Query task controller for heartbeat health
   *
   * Calls the task controller's /health endpoint to get the agent's heartbeat status.
   * This is used to determine if the agent is still alive and processing the task.
   */
  private async queryHeartbeatHealth(taskId: string): Promise<HeartbeatHealthResponse | null> {
    try {
      const response = await this.taskControllerClient.get(`/api/v1/tasks/${taskId}/health`);
      return response.data as HeartbeatHealthResponse;
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 404) {
        // Task not found in task controller - treat as unhealthy
        this.logger.debug(`Heartbeat health query 404 for ${taskId}`);
        return null;
      }
      // Other errors - log but don't fail (fallback to status-based health)
      this.logger.warn(`Heartbeat health query failed for ${taskId}: ${error.message}`);
      return null;
    }
  }

  /**
   * v1.2.0 Phase C: Update heartbeat health for a dispatch record
   *
   * Called during status polling to check and update heartbeat health.
   * This tracks consecutive unhealthy heartbeat checks for timeout decisions.
   */
  async updateHeartbeatHealth(record: DispatchRecord): Promise<void> {
    const health = await this.queryHeartbeatHealth(record.taskId);
    const now = new Date();

    if (!health) {
      // Query failed - increment unhealthy count
      record.consecutiveHeartbeatUnhealthy++;
      record.isHeartbeatHealthy = false;
      record.lastHeartbeatCheck = now;
      this.dispatchRecords.set(record.idempotencyKey, record);

      this.logger.debug(
        `Heartbeat health unknown for ${record.taskId} ` +
        `(${record.consecutiveHeartbeatUnhealthy} consecutive unhealthy)`,
      );
      return;
    }

    record.lastHeartbeatCheck = now;

    if (health.agentHeartbeat) {
      record.lastHeartbeatTime = new Date(health.agentHeartbeat);
    }

    if (health.isHeartbeatHealthy) {
      // Heartbeat is healthy - reset unhealthy counter
      record.isHeartbeatHealthy = true;
      record.consecutiveHeartbeatUnhealthy = 0;
    } else {
      // Heartbeat is unhealthy - increment counter
      record.isHeartbeatHealthy = false;
      record.consecutiveHeartbeatUnhealthy++;

      this.logger.warn(
        `Heartbeat unhealthy for ${record.taskId}: ` +
        `${health.timeSinceHeartbeat}s since last heartbeat, phase=${health.phase} ` +
        `(${record.consecutiveHeartbeatUnhealthy}/${this.heartbeatUnhealthyThreshold})`,
      );
    }

    this.dispatchRecords.set(record.idempotencyKey, record);
  }

  /**
   * v1.2.0 Phase C: Get heartbeat health for timeout decisions
   *
   * Returns heartbeat health information that the orchestrator-loop uses
   * to make timeout decisions. Replaces static TTL-based timeout with
   * dynamic heartbeat-based timeout.
   */
  getHeartbeatHealth(checklistItemId: string): {
    hasActiveDispatch: boolean;
    isHealthy: boolean;
    consecutiveUnhealthy: number;
    lastHeartbeat?: Date;
    shouldTimeout: boolean;
  } {
    // Find dispatch record for this checklist item
    const record = Array.from(this.dispatchRecords.values()).find(
      r => r.checklistItemId === checklistItemId && (r.status === 'DISPATCHED' || r.status === 'RUNNING'),
    );

    if (!record) {
      return {
        hasActiveDispatch: false,
        isHealthy: true,
        consecutiveUnhealthy: 0,
        shouldTimeout: false,
      };
    }

    // Timeout if consecutive unhealthy checks exceed threshold
    const shouldTimeout = record.consecutiveHeartbeatUnhealthy >= this.heartbeatUnhealthyThreshold;

    return {
      hasActiveDispatch: true,
      isHealthy: record.isHeartbeatHealthy,
      consecutiveUnhealthy: record.consecutiveHeartbeatUnhealthy,
      lastHeartbeat: record.lastHeartbeatTime,
      shouldTimeout,
    };
  }

  /**
   * v2.4.1: Build previous step results with context summarization
   *
   * For long step histories, this method summarizes earlier steps and provides
   * full detail only for recent steps. This prevents context window overflow
   * while preserving important continuity information.
   *
   * Strategy:
   * - Last N steps (configurable): Full detail with outcome
   * - Earlier steps: Brief summary (description only)
   * - Total output capped at max chars
   */
  private buildPreviousStepResults(
    completedItems: Array<{
      description: string;
      actualOutcome: string | null;
      order: number;
    }>,
  ): string | undefined {
    if (completedItems.length === 0) {
      return undefined;
    }

    const { maxPreviousStepsDetailed, maxContextChars } = CONTEXT_SUMMARIZATION_CONFIG;

    // Parse outcome from each step
    const stepsWithOutcome = completedItems.map((ci, idx) => {
      let outcome = '';
      if (ci.actualOutcome) {
        try {
          const parsed = JSON.parse(ci.actualOutcome);
          outcome = parsed.summary || '';
        } catch {
          // Fallback: treat as plain string, but skip error messages
          outcome = ci.actualOutcome.startsWith('Error:') ? '' : ci.actualOutcome;
        }
      }
      return {
        index: idx + 1,
        description: ci.description,
        outcome,
        order: ci.order,
      };
    });

    // Determine which steps get full detail vs summary
    const totalSteps = stepsWithOutcome.length;
    const detailedStartIdx = Math.max(0, totalSteps - maxPreviousStepsDetailed);

    const parts: string[] = [];

    // Earlier steps (summarized) - just descriptions
    if (detailedStartIdx > 0) {
      const summarizedSteps = stepsWithOutcome.slice(0, detailedStartIdx);
      parts.push(`[Earlier steps 1-${detailedStartIdx} completed successfully]`);

      // Add brief list if not too many
      if (summarizedSteps.length <= 3) {
        summarizedSteps.forEach((step) => {
          parts.push(`  ${step.index}. ${step.description.slice(0, 80)}${step.description.length > 80 ? '...' : ''}`);
        });
      }
    }

    // Recent steps (detailed) - with outcomes
    const detailedSteps = stepsWithOutcome.slice(detailedStartIdx);
    detailedSteps.forEach((step) => {
      const outcomeStr = step.outcome ? `: ${step.outcome}` : '';
      parts.push(`${step.index}. ${step.description}${outcomeStr}`);
    });

    // Join and truncate if needed
    let result = parts.join('\n');

    if (result.length > maxContextChars) {
      // Truncate and add indicator
      result = result.slice(0, maxContextChars - 50) + '\n[...truncated for brevity]';
      this.logger.warn({
        message: 'Previous step results truncated due to length',
        originalLength: parts.join('\n').length,
        truncatedTo: result.length,
        stepCount: completedItems.length,
      });
    }

    return result;
  }
}
