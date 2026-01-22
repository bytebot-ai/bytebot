import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { Injectable, Logger } from '@nestjs/common';
import {
  Message,
  Role,
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '@prisma/client';
import { AnthropicService } from '../anthropic/anthropic.service';
import {
  isComputerToolUseContentBlock,
  isSetTaskStatusToolUseBlock,
  isCreateTaskToolUseBlock,
  SetTaskStatusToolUseBlock,
} from '@bytebot/shared';

import {
  MessageContentBlock,
  MessageContentType,
  ToolResultContentBlock,
  TextContentBlock,
} from '@bytebot/shared';
import { InputCaptureService } from './input-capture.service';
import { OnEvent } from '@nestjs/event-emitter';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import {
  BytebotAgentModel,
  BytebotAgentService,
  BytebotAgentResponse,
} from './agent.types';
import {
  AGENT_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './agent.constants';
import { SummariesService } from '../summaries/summaries.service';
import {
  handleComputerToolUse,
  ActionContext,
  ActionResult,
  DesktopRequiredError,
} from './agent.computer-use';
import { ProxyService } from '../proxy/proxy.service';
import { TaskControllerService } from '../task-controller/task-controller.service';
import {
  ActionLoggingService,
  ActionLogEntry,
} from '../action-logging/action-logging.service';
import {
  validateMessageHistory,
  formatValidationError,
} from './message-history.validator';
// v2.2.7: Import Mutex to prevent concurrent iteration execution
import { Mutex } from 'async-mutex';
// v2.3.0 M4: Import WorkspaceService for workspace-aware desktop resolution
import { WorkspaceService } from '../workspace/workspace.service';
import {
  isDispatchedUserPromptStep,
  resolveExecutionSurface,
  shouldAcquireDesktop,
} from './execution-surface';
import { buildNeedsHelpResult, parseNeedsHelpErrorCode } from './needs-help';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DESKTOP_MAX_ACTIONS_WITHOUT_OBSERVATION,
  DESKTOP_LOOP_COORDINATE_BUCKET_PX,
  DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING,
  DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED,
  DESKTOP_LOOP_REPAIR_ATTEMPT2_MIN_CONFIDENCE,
  DESKTOP_LOOP_REPAIR_ENABLED,
  DESKTOP_LOOP_REPAIR_EPISODE_MAX_MS,
  DESKTOP_LOOP_REPEAT_THRESHOLD,
  DESKTOP_TOOL_CONTRACT_VIOLATION_LIMIT,
  DesktopLoopDetector,
  hammingDistanceHex,
  normalizeComputerToolUseBlock,
} from './agent.desktop-safety';
import { resetDesktopInput } from './agent.computer-use';
import {
  buildUiRepairClassifierMessage,
  buildUiRepairClassifierSystemPrompt,
  decodePngDimensionsFromBase64,
  parseUiRepairCandidate,
  validateUiRepairCandidate,
} from './agent.desktop-repair';

const DESKTOP_OBSERVATION_REQUIRED_TOOLS = new Set([
  'computer_move_mouse',
  'computer_trace_mouse',
  'computer_click_mouse',
  'computer_press_mouse',
  'computer_drag_mouse',
  'computer_scroll',
  'computer_type_keys',
  'computer_press_keys',
  'computer_type_text',
  'computer_paste_text',
  'computer_wait',
  'computer_application',
]);

type DesktopUiRepairEpisode = {
  episodeId: number;
  startedAtMs: number;
  anchorHash: string | null;
  escUsed: boolean;
  closeClickUsed: boolean;
  progressCandidateHash: string | null;
  progressCandidateCount: number;
};

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private currentTaskId: string | null = null;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private services: Record<string, BytebotAgentService> = {};
  // v2.2.1: Track cached desktop URL per task to avoid repeated waits
  private cachedDesktopUrl: string | null = null;
  private desktopLoopDetector = new DesktopLoopDetector();
  private desktopToolContractViolations = 0;
  private desktopActionsWithoutObservation = 0;
  private lastScreenshotHash: string | null = null;
  private blockedClickBuckets = new Map<
    string,
    { sinceHash: string; blockedAtMs: number; count: number }
  >();
  private pendingForcedScreenshot = false;
  private pendingForcedScreenshotReason: 'actions_budget' | null = null;
  private pendingDesktopRepairTrigger: {
    trigger: 'loop' | 'blocked_click';
    details?: Record<string, unknown>;
  } | null = null;
  private desktopUiRepairEpisodeSeq = 0;
  private desktopUiRepairEpisode: DesktopUiRepairEpisode | null = null;
  private desktopUiRepairInProgress = false;
  private pendingDesktopNeedsHelp: ReturnType<
    typeof buildNeedsHelpResult
  > | null = null;
  // v2.2.7: Mutex to prevent concurrent iteration execution
  // This prevents race conditions where multiple LLM calls could be made simultaneously
  // See: 2025-12-09-race-condition-duplicate-llm-calls-fix.md
  private readonly iterationMutex = new Mutex();

  /**
   * Safely schedules the next iteration with proper error handling.
   * v2.0.28: Added to prevent unhandled promise rejections from fire-and-forget calls.
   *
   * Instead of `void this.runIteration(taskId)` which ignores errors,
   * this method catches and logs any errors that occur.
   */
  private safeRunIteration(taskId: string): void {
    this.runIteration(taskId).catch((error: Error) => {
      const timestamp = new Date().toISOString();

      // Phase 4: Specifically identify DesktopRequiredError for execution surface violations
      if (error instanceof DesktopRequiredError) {
        this.logger.error(
          `[${timestamp}] [Phase 4] Task ${taskId} failed: Desktop required but not available. ${error.message}`,
        );
      } else {
        this.logger.error(
          `[${timestamp}] Unhandled error in runIteration for task ${taskId}: ${error.message}`,
          error.stack,
        );
      }

      // Attempt to mark task as failed if we haven't already
      // Phase 4: Include error message for DesktopRequiredError and other failures
      if (this.isProcessing && this.currentTaskId === taskId) {
        this.tasksService
          .update(taskId, { status: TaskStatus.FAILED, error: error.message })
          .catch((updateError: Error) => {
            this.logger.error(
              `[${timestamp}] Failed to mark task ${taskId} as FAILED after error: ${updateError.message}`,
            );
          });

        this.isProcessing = false;
        this.currentTaskId = null;
      }
    });
  }

  /**
   * Safely schedules the next iteration via setImmediate with proper error handling.
   * v2.0.28: Replaces bare setImmediate to prevent unhandled promise rejections.
   */
  private scheduleNextIteration(taskId: string): void {
    setImmediate(() => {
      this.safeRunIteration(taskId);
    });
  }

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly summariesService: SummariesService,
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly proxyService: ProxyService,
    private readonly inputCaptureService: InputCaptureService,
    private readonly taskControllerService: TaskControllerService,
    private readonly actionLoggingService: ActionLoggingService,
    // v2.3.0 M4: WorkspaceService for persistent workspace resolution and locking
    private readonly workspaceService: WorkspaceService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      proxy: this.proxyService,
    };
    this.logger.log('AgentProcessor initialized');

    // Log Phase 6 status
    if (this.taskControllerService.isPhase6Enabled()) {
      this.logger.log('Phase 6 task controller integration enabled');
    } else {
      this.logger.log('Phase 6 not enabled - using legacy desktop URL mode');
    }

    // v2.3.0 M4: Log workspace feature status
    if (this.workspaceService.isWorkspaceEnabled()) {
      this.logger.log('Workspace features enabled (Product 2: Workflows)');
    } else {
      this.logger.log('Workspace features disabled (Product 1 only)');
    }
  }

  /**
   * Check if the processor is currently processing a task
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current task ID being processed
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  @OnEvent('task.takeover')
  handleTaskTakeover({ taskId }: { taskId: string }) {
    this.logger.log(`Task takeover event received for task ID: ${taskId}`);

    // If the agent is still processing this task, abort any in-flight operations
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.abortController?.abort();
    }

    // Always start capturing user input so that emitted actions are received
    this.inputCaptureService.start(taskId);
  }

  @OnEvent('task.resume')
  handleTaskResume({ taskId }: { taskId: string }) {
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.logger.log(`Task resume event received for task ID: ${taskId}`);
      this.abortController = new AbortController();

      this.safeRunIteration(taskId);
    }
  }

  @OnEvent('task.cancel')
  async handleTaskCancel({ taskId }: { taskId: string }) {
    this.logger.log(`Task cancel event received for task ID: ${taskId}`);

    await this.stopProcessing();
  }

  processTask(taskId: string) {
    this.logger.log(`Starting processing for task ID: ${taskId}`);

    if (this.isProcessing) {
      this.logger.warn('AgentProcessor is already processing another task');
      return;
    }

    this.isProcessing = true;
    this.currentTaskId = taskId;
    this.abortController = new AbortController();
    // v2.2.1: Reset cached desktop URL for new task
    this.cachedDesktopUrl = null;
    this.desktopLoopDetector = new DesktopLoopDetector();
    this.desktopToolContractViolations = 0;
    this.desktopActionsWithoutObservation = 0;
    this.pendingDesktopNeedsHelp = null;

    // Phase 6.4: Start heartbeat for this task
    this.taskControllerService.startHeartbeat(taskId);

    // Kick off the first iteration without blocking the caller
    // v2.0.28: Use safe wrapper to catch async errors
    this.safeRunIteration(taskId);
  }

  /**
   * Runs a single iteration of task processing and schedules the next
   * iteration via setImmediate while the task remains RUNNING.
   *
   * v2.2.7: Uses mutex to prevent concurrent iterations that could cause
   * duplicate LLM calls and message history corruption.
   */
  private async runIteration(taskId: string): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    // v2.2.7: Use mutex to serialize iteration execution
    // This prevents concurrent iterations from handleTaskResume or other triggers
    const iterationId = `iter-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Check if mutex is already locked (another iteration is in progress)
    if (this.iterationMutex.isLocked()) {
      this.logger.warn(
        `[${iterationId}] Iteration already in progress for task ${taskId}, skipping duplicate call`,
      );
      return;
    }

    return this.iterationMutex.runExclusive(async () => {
      this.logger.debug(
        `[${iterationId}] Starting iteration for task ${taskId}`,
      );

      try {
        const task: Task = await this.tasksService.findById(taskId);

        if (task.status !== TaskStatus.RUNNING) {
          this.logger.log(
            `Task processing completed for task ID: ${taskId} with status: ${task.status}`,
          );

          // Phase 6.4: Cleanup heartbeat and flush logs on task completion
          this.taskControllerService.stopHeartbeat(taskId);
          try {
            await this.actionLoggingService.flushActions(taskId);
          } catch (error: any) {
            this.logger.warn(
              `Failed to flush action logs for ${taskId}: ${error.message}`,
            );
          }

          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        this.logger.log(`Processing iteration for task ID: ${taskId}`);

        // Stark Fix (Atom 5): Defensive guard — prompt steps must never be executed by the agent.
        // Prefer explicit machine flags over NL heuristics: a prompt-step is identified by ASK_USER tool.
        if (isDispatchedUserPromptStep({ allowedTools: task.allowedTools })) {
          this.logger.error(
            `Task ${taskId} appears to be a USER_INPUT_REQUIRED prompt step (allowedTools includes ASK_USER). ` +
              `This must not be dispatched to the agent.`,
          );

          await this.tasksService.update(taskId, {
            status: TaskStatus.NEEDS_HELP,
            result: {
              ...buildNeedsHelpResult({
                errorCode: 'DISPATCHED_USER_PROMPT_STEP',
                message:
                  'This task requires user input and must not be executed by the agent. ' +
                  'Orchestrator should create a UserPrompt and wait.',
              }),
            },
          });
          await this.tasksService.clearLease(taskId);
          this.taskControllerService.stopHeartbeat(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        // Refresh abort controller for this iteration to avoid accumulating
        // "abort" listeners on a single AbortSignal across iterations.
        this.abortController = new AbortController();

        const latestSummary = await this.summariesService.findLatest(taskId);
        const unsummarizedMessages =
          await this.messagesService.findUnsummarized(taskId);
        const messages = [
          ...(latestSummary
            ? [
                {
                  id: '',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  taskId,
                  summaryId: null,
                  role: Role.USER,
                  content: [
                    {
                      type: MessageContentType.Text,
                      text: latestSummary.content,
                    },
                  ],
                },
              ]
            : []),
          ...unsummarizedMessages,
        ];
        this.logger.debug(
          `Sending ${messages.length} messages to LLM for processing`,
        );

        // v2.2.5: Validate message history before sending to LLM
        // This catches corruption from race conditions or worker crashes
        const validation = validateMessageHistory(messages, this.logger);
        if (!validation.isValid) {
          const errorMessage = formatValidationError(validation);
          this.logger.error(
            `Task ${taskId}: Message history validation failed - ${errorMessage}`,
          );
          this.logger.error(
            `Orphaned tool_use IDs: ${validation.orphanedToolUseIds.join(', ')}`,
          );

          await this.tasksService.update(taskId, {
            status: TaskStatus.FAILED,
            error: errorMessage,
          });

          // Clear lease since task is done
          await this.tasksService.clearLease(taskId);

          this.isProcessing = false;
          this.currentTaskId = null;
          this.taskControllerService.stopHeartbeat(taskId);
          return;
        }

        const model = task.model as unknown as BytebotAgentModel;
        let agentResponse: BytebotAgentResponse;

        const service = this.services[model.provider];
        if (!service) {
          this.logger.warn(
            `No service found for model provider: ${model.provider}`,
          );
          await this.tasksService.update(taskId, {
            status: TaskStatus.FAILED,
          });
          await this.tasksService.clearLease(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        // Stark Fix (Atom 5): Determine execution surface up front.
        // Default behavior: requiresDesktop=true -> DESKTOP, otherwise TEXT_ONLY.
        // If an explicit surface is present, it is honored (but desktop acquisition still requires requiresDesktop=true).
        const executionSurface = resolveExecutionSurface({
          requiresDesktop: task.requiresDesktop,
          executionSurface: task.executionSurface,
        });

        agentResponse = await service.generateMessage(
          AGENT_SYSTEM_PROMPT,
          messages,
          model.name,
          {
            useTools: true,
            toolPolicy: {
              requiresDesktop: task.requiresDesktop,
              executionSurface,
              gatewayToolsOnly: task.gatewayToolsOnly,
              allowedTools: task.allowedTools,
            },
            signal: this.abortController.signal,
          },
        );

        const messageContentBlocks = agentResponse.contentBlocks;

        this.logger.debug(
          `Received ${messageContentBlocks.length} content blocks from LLM`,
        );

        if (messageContentBlocks.length === 0) {
          // v2.0.23: Changed from FAILED to NEEDS_HELP
          // Empty response doesn't necessarily mean failure - could be:
          // - Thinking-only responses
          // - Tool execution results without text
          // - Edge cases in response formatting
          // Escalating to NEEDS_HELP allows user to review and resume
          this.logger.warn(
            `Task ID: ${taskId} received no content blocks from LLM, escalating to needs_help`,
          );
          await this.tasksService.update(taskId, {
            status: TaskStatus.NEEDS_HELP,
            result: buildNeedsHelpResult({
              errorCode: 'LLM_EMPTY_RESPONSE',
              message:
                'Task received no content blocks from LLM (empty response).',
              details: {
                provider: model.provider,
                model: model.name,
              },
            }),
          });
          // v2.2.5: Clear lease when escalating
          await this.tasksService.clearLease(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        await this.messagesService.create({
          content: messageContentBlocks,
          role: Role.ASSISTANT,
          taskId,
        });

        // Calculate if we need to summarize based on token usage
        const contextWindow = model.contextWindow || 200000; // Default to 200k if not specified
        const contextThreshold = contextWindow * 0.75;
        const shouldSummarize =
          agentResponse.tokenUsage.totalTokens >= contextThreshold;

        if (shouldSummarize) {
          try {
            // After we've successfully generated a response, we can summarize the unsummarized messages
            const summaryResponse = await service.generateMessage(
              SUMMARIZATION_SYSTEM_PROMPT,
              [
                ...messages,
                {
                  id: '',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  taskId,
                  summaryId: null,
                  role: Role.USER,
                  content: [
                    {
                      type: MessageContentType.Text,
                      text: 'Respond with a summary of the messages above. Do not include any additional information.',
                    },
                  ],
                },
              ],
              model.name,
              { useTools: false, signal: this.abortController.signal },
            );

            const summaryContentBlocks = summaryResponse.contentBlocks;

            this.logger.debug(
              `Received ${summaryContentBlocks.length} summary content blocks from LLM`,
            );
            const summaryContent = summaryContentBlocks
              .filter(
                (block: MessageContentBlock) =>
                  block.type === MessageContentType.Text,
              )
              .map((block: TextContentBlock) => block.text)
              .join('\n');

            const summary = await this.summariesService.create({
              content: summaryContent,
              taskId,
            });

            await this.messagesService.attachSummary(taskId, summary.id, [
              ...messages.map((message) => {
                return message.id;
              }),
            ]);

            this.logger.log(
              `Generated summary for task ${taskId} due to token usage (${agentResponse.tokenUsage.totalTokens}/${contextWindow})`,
            );
          } catch (error: any) {
            this.logger.error(
              `Error summarizing messages for task ID: ${taskId}`,
              error.stack,
            );
          }
        }

        this.logger.debug(
          `Token usage for task ${taskId}: ${agentResponse.tokenUsage.totalTokens}/${contextWindow} (${Math.round((agentResponse.tokenUsage.totalTokens / contextWindow) * 100)}%)`,
        );

        const generatedToolResults: MessageContentBlock[] = [];

        let setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock | null = null;

        // v2.3.0 M4: Check if this response contains desktop tool use blocks
        const hasDesktopToolUse = messageContentBlocks.some(
          isComputerToolUseContentBlock,
        );

        // Text-only means text-only: never wait for/acquire a desktop when requiresDesktop=false or surface=TEXT_ONLY.
        const acquireDesktop = shouldAcquireDesktop({
          requiresDesktop: task.requiresDesktop,
          surface: executionSurface,
          hasDesktopToolUse,
        });

        if (hasDesktopToolUse && !acquireDesktop) {
          this.logger.warn(
            `Task ${taskId} requested desktop tool use but desktop is not allowed ` +
              `(requiresDesktop=${task.requiresDesktop}, surface=${executionSurface}).`,
          );

          await this.tasksService.update(taskId, {
            status: TaskStatus.NEEDS_HELP,
            result: {
              ...buildNeedsHelpResult({
                errorCode: 'DESKTOP_NOT_ALLOWED',
                message:
                  'Desktop tools were requested, but this task is configured for TEXT_ONLY execution. ' +
                  'Orchestrator may have misrouted this step.',
                details: {
                  requiresDesktop: task.requiresDesktop,
                  executionSurface,
                },
              }),
            },
          });
          await this.tasksService.clearLease(taskId);
          this.taskControllerService.stopHeartbeat(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        // v2.3.0 M4: Workspace-aware desktop resolution
        // For Product 2 Workflows (workspaceId set): Use WorkspaceService
        // For Product 1 Tasks (workspaceId null): Use TaskControllerService
        let desktopUrl: string | undefined;
        const workspaceId = (task as any).workspaceId as string | null;
        const nodeRunId = (task as any).nodeRunId as string | null;

        if (acquireDesktop) {
          if (this.cachedDesktopUrl) {
            desktopUrl = this.cachedDesktopUrl;
            this.logger.debug(
              `Using cached desktop URL for task ${taskId}: ${desktopUrl}`,
            );
          } else if (
            workspaceId &&
            this.workspaceService.isWorkspaceEnabled()
          ) {
            // Product 2: Workflow with persistent workspace
            try {
              this.logger.log(
                `Waiting for workspace ${workspaceId} to be ready for task ${taskId}...`,
              );
              desktopUrl = await this.workspaceService.waitForWorkspaceReady(
                workspaceId,
                {
                  timeoutMs: 120000, // 2 minute timeout (includes wake time from hibernation)
                },
              );
              this.cachedDesktopUrl = desktopUrl;
              this.logger.log(
                `Workspace ${workspaceId} ready for task ${taskId}: ${desktopUrl}`,
              );
            } catch (error: any) {
              this.logger.error(
                `Failed to get workspace ${workspaceId} for task ${taskId}: ${error.message}`,
              );
              await this.tasksService.update(taskId, {
                status: TaskStatus.FAILED,
                error: `Failed to get workspace: ${error.message}`,
              });
              await this.tasksService.clearLease(taskId);
              this.isProcessing = false;
              this.currentTaskId = null;
              this.taskControllerService.stopHeartbeat(taskId);
              return;
            }
          } else {
            // Product 1: Task with ephemeral desktop (Phase 6)
            try {
              this.logger.log(
                `Waiting for desktop to be ready for task ${taskId}...`,
              );
              desktopUrl = await this.taskControllerService.waitForDesktop(
                taskId,
                {
                  timeoutMs: 60000, // 60 second timeout
                },
              );
              this.cachedDesktopUrl = desktopUrl;
              this.logger.log(
                `Desktop ready for task ${taskId}: ${desktopUrl}`,
              );
            } catch (error: any) {
              this.logger.error(
                `Failed to get desktop for task ${taskId}: ${error.message}`,
              );
              // Mark task as failed if we can't get a desktop
              await this.tasksService.update(taskId, {
                status: TaskStatus.FAILED,
                error: `Failed to get desktop: ${error.message}`,
              });
              await this.tasksService.clearLease(taskId);
              this.isProcessing = false;
              this.currentTaskId = null;
              this.taskControllerService.stopHeartbeat(taskId);
              return;
            }
          }
        }

        // Phase 6.4: Create action context for logging
        // Phase 4: Include requiresDesktop for fail-fast validation
        const actionContext: ActionContext = {
          taskId,
          desktopUrl,
          requiresDesktop: task.requiresDesktop,
          onAction: (action: ActionResult) => {
            this.handleDesktopSafetyAction(action);

            // Log action asynchronously (non-blocking)
            const logEntry: ActionLogEntry = {
              taskId,
              actionType: action.actionType,
              actionStatus: action.success ? 'success' : 'failed',
              coordinates: action.coordinates,
              durationMs: action.durationMs,
              errorMessage: action.errorMessage,
              actionData: action.input,
              llmModel: model.name,
            };
            this.actionLoggingService.logAction(logEntry).catch((err) => {
              this.logger.warn(`Failed to log action: ${err.message}`);
            });
          },
        };

        const needsWorkspaceLock =
          workspaceId && nodeRunId && hasDesktopToolUse;
        let workspaceLockAcquired = false;

        // v2.3.0 M4: Acquire granular workspace lock before desktop tool execution
        // Lock is held only during active desktop tool execution (30-60 seconds)
        if (needsWorkspaceLock) {
          const lockResult = await this.workspaceService.acquireLock(
            workspaceId,
            nodeRunId,
          );
          if (!lockResult.acquired) {
            // Lock contention - another node run is using the workspace
            this.logger.warn(
              `Lock contention on workspace ${workspaceId}: ${lockResult.message}. ` +
                `Retrying after ${lockResult.retryAfterMs || 5000}ms`,
            );
            // Wait and retry in next iteration
            await new Promise((resolve) =>
              setTimeout(resolve, lockResult.retryAfterMs || 5000),
            );
            // Schedule next iteration to retry
            if (this.isProcessing) {
              this.scheduleNextIteration(taskId);
            }
            return;
          }
          workspaceLockAcquired = true;
          this.logger.log(
            `Workspace lock acquired for task ${taskId} (nodeRun: ${nodeRunId})`,
          );
        }

        try {
          const handledToolUseIds = new Set<string>();
          let shortCircuitReason:
            | 'ui_repair_esc'
            | 'ui_repair_close_click'
            | 'takeover_required'
            | null = null;

          for (const block of messageContentBlocks) {
            if (isComputerToolUseContentBlock(block)) {
              const normalized = normalizeComputerToolUseBlock(block);

              // Hard invariant: never keep clicking the same region when it produces no progress.
              if (
                normalized.normalizedBlock.name === 'computer_click_mouse' &&
                desktopUrl &&
                !this.pendingDesktopNeedsHelp
              ) {
                const input = (normalized.normalizedBlock as any).input as
                  | { coordinates?: { x: number; y: number } }
                  | undefined;
                const coords = input?.coordinates;
                if (
                  coords &&
                  typeof coords.x === 'number' &&
                  typeof coords.y === 'number' &&
                  Number.isFinite(coords.x) &&
                  Number.isFinite(coords.y)
                ) {
                  const bx = Math.floor(
                    coords.x / DESKTOP_LOOP_COORDINATE_BUCKET_PX,
                  );
                  const by = Math.floor(
                    coords.y / DESKTOP_LOOP_COORDINATE_BUCKET_PX,
                  );
                  const bucketKey = `${bx},${by}`;

                  const blocked = this.blockedClickBuckets.get(bucketKey);
                  const stillNoProgress =
                    blocked &&
                    this.lastScreenshotHash &&
                    hammingDistanceHex(
                      blocked.sinceHash,
                      this.lastScreenshotHash,
                    ) <= DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING;

                  if (stillNoProgress) {
                    generatedToolResults.push({
                      type: MessageContentType.ToolResult,
                      tool_use_id: block.id,
                      is_error: true,
                      content: [
                        {
                          type: MessageContentType.Text,
                          text: '[System] Blocked repeating click in the same UI region with no progress; running the bounded UI repair ladder.',
                        },
                      ],
                    } as any);
                    handledToolUseIds.add(block.id);

                    const repair = await this.performDesktopUiRepair({
                      taskId,
                      desktopUrl,
                      actionContext,
                      trigger: 'blocked_click',
                      triggerDetails: {
                        bucketKey,
                        blockedClickCount: blocked.count,
                      },
                      service,
                      model,
                      generatedToolResults,
                    });

                    shortCircuitReason = repair.shortCircuitReason;
                    break;
                  }
                }
              }

              if (
                normalized.rewriteReason === 'non_modifier_down_to_tap' ||
                normalized.rewriteReason ===
                  'modifier_down_missing_holdms_to_tap'
              ) {
                this.desktopToolContractViolations++;
                const rewrittenKeys = normalized.rewrittenKeys || [];
                for (const key of rewrittenKeys) {
                  this.eventEmitter.emit('desktop.keydown.rewritten', {
                    key,
                    reason: normalized.rewriteReason,
                  });
                }

                if (
                  this.desktopToolContractViolations >=
                    DESKTOP_TOOL_CONTRACT_VIOLATION_LIMIT &&
                  !this.pendingDesktopNeedsHelp
                ) {
                  this.pendingDesktopNeedsHelp = buildNeedsHelpResult({
                    errorCode: 'TOOL_CONTRACT_VIOLATION',
                    details: {
                      violations: this.desktopToolContractViolations,
                      limit: DESKTOP_TOOL_CONTRACT_VIOLATION_LIMIT,
                      lastRewriteReason: normalized.rewriteReason,
                      lastRewrittenKeys: rewrittenKeys,
                      recentActions: this.desktopLoopDetector.getRecent(),
                    },
                  });
                  this.eventEmitter.emit('desktop.interrupt', {
                    reasonCode: 'TOOL_CONTRACT_VIOLATION',
                  });
                }
              }

              const result = await handleComputerToolUse(
                normalized.normalizedBlock,
                this.logger,
                actionContext,
              );
              generatedToolResults.push(result);
              handledToolUseIds.add(block.id);

              if (
                this.pendingForcedScreenshot &&
                this.pendingForcedScreenshotReason === 'actions_budget' &&
                desktopUrl &&
                !this.pendingDesktopNeedsHelp
              ) {
                const actionsWithoutObservation =
                  this.desktopActionsWithoutObservation;
                this.pendingForcedScreenshot = false;
                this.pendingForcedScreenshotReason = null;

                const forcedToolUseId = `forced_screenshot_${Date.now()}`;
                const forcedScreenshotBlock = {
                  type: MessageContentType.ToolUse,
                  id: forcedToolUseId,
                  name: 'computer_screenshot',
                  input: {},
                } as any;

                const forcedResult = await handleComputerToolUse(
                  forcedScreenshotBlock,
                  this.logger,
                  actionContext,
                );

                const content = Array.isArray((forcedResult as any).content)
                  ? ((forcedResult as any).content as any[])
                  : [];

                const images = content.filter(
                  (c) =>
                    c &&
                    typeof c === 'object' &&
                    c.type === MessageContentType.Image,
                );

                if (images.length > 0) {
                  generatedToolResults.push({
                    type: MessageContentType.Text,
                    text: '[System] Forced screenshot for observation (actions budget).',
                  } as any);
                  generatedToolResults.push(...(images as any));
                } else {
                  // If we cannot observe, we must stop deterministically (typed interrupt).
                  this.pendingDesktopNeedsHelp = buildNeedsHelpResult({
                    errorCode: 'UI_OBSERVATION_FAILED',
                    message:
                      'Forced screenshot failed; cannot safely proceed without observation.',
                    details: {
                      reason: 'forced_screenshot_failed',
                      actionsWithoutObservation,
                      limit: DESKTOP_MAX_ACTIONS_WITHOUT_OBSERVATION,
                      lastToolResult: content,
                    },
                  });
                  this.eventEmitter.emit('desktop.interrupt', {
                    reasonCode: 'UI_OBSERVATION_FAILED',
                  });
                }
              }

              // Modal-aware bounded self-repair. Runs after we observe a no-progress loop.
              if (
                this.pendingDesktopRepairTrigger &&
                desktopUrl &&
                !this.pendingDesktopNeedsHelp
              ) {
                const trigger = this.pendingDesktopRepairTrigger;
                this.pendingDesktopRepairTrigger = null;

                const repair = await this.performDesktopUiRepair({
                  taskId,
                  desktopUrl,
                  actionContext,
                  trigger: trigger.trigger,
                  triggerDetails: trigger.details,
                  service,
                  model,
                  generatedToolResults,
                });

                shortCircuitReason = repair.shortCircuitReason;
                break;
              }

              if (this.pendingDesktopNeedsHelp) {
                break;
              }
            }

            if (isCreateTaskToolUseBlock(block)) {
              const type = block.input.type?.toUpperCase() as TaskType;
              const priority =
                block.input.priority?.toUpperCase() as TaskPriority;

              await this.tasksService.create({
                description: block.input.description,
                type,
                createdBy: Role.ASSISTANT,
                ...(block.input.scheduledFor && {
                  scheduledFor: new Date(block.input.scheduledFor),
                }),
                model: task.model,
                priority,
              });

              generatedToolResults.push({
                type: MessageContentType.ToolResult,
                tool_use_id: block.id,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: 'The task has been created',
                  },
                ],
              });
              handledToolUseIds.add(block.id);
            }

            if (isSetTaskStatusToolUseBlock(block)) {
              setTaskStatusToolUseBlock = block;

              generatedToolResults.push({
                type: MessageContentType.ToolResult,
                tool_use_id: block.id,
                is_error: block.input.status === 'failed',
                content: [
                  {
                    type: MessageContentType.Text,
                    text: block.input.description,
                  },
                ],
              });
              handledToolUseIds.add(block.id);
            }
          }

          if (shortCircuitReason) {
            // Ensure the assistant's tool-use message is fully acknowledged with tool results.
            // We intentionally skip remaining tool calls to allow the model to replan using
            // the latest screenshot after safety repair.
            for (const block of messageContentBlocks) {
              if (
                block &&
                typeof block === 'object' &&
                (block as any).type === MessageContentType.ToolUse &&
                typeof (block as any).id === 'string' &&
                !handledToolUseIds.has((block as any).id)
              ) {
                generatedToolResults.push({
                  type: MessageContentType.ToolResult,
                  tool_use_id: (block as any).id,
                  is_error: true,
                  content: [
                    {
                      type: MessageContentType.Text,
                      text: `[System] Skipped tool execution due to desktop safety intervention (${shortCircuitReason}). Replan using the latest screenshot.`,
                    },
                  ],
                } as any);
                handledToolUseIds.add((block as any).id);
              }
            }
          }
        } finally {
          // v2.3.0 M4: Release workspace lock after desktop tool execution
          if (workspaceLockAcquired && workspaceId && nodeRunId) {
            await this.workspaceService.releaseLock(workspaceId, nodeRunId);
            this.logger.log(
              `Workspace lock released for task ${taskId} (nodeRun: ${nodeRunId})`,
            );
          }
        }

        if (generatedToolResults.length > 0) {
          await this.messagesService.create({
            content: generatedToolResults,
            role: Role.USER,
            taskId,
          });
        }

        if (this.pendingDesktopNeedsHelp) {
          // Best-effort cleanup: release any potentially stuck keys/buttons before yielding.
          if (desktopUrl) {
            try {
              await resetDesktopInput(desktopUrl);
            } catch (error: any) {
              this.logger.warn(
                `Failed to reset desktop input for task ${taskId}: ${error.message}`,
              );
            }
          }

          await this.tasksService.update(taskId, {
            status: TaskStatus.NEEDS_HELP,
            result: this.pendingDesktopNeedsHelp,
          });
          await this.tasksService.clearLease(taskId);
          this.taskControllerService.stopHeartbeat(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
          return;
        }

        // Update the task status after all tool results have been generated if we have a set task status tool use block
        if (setTaskStatusToolUseBlock) {
          switch (setTaskStatusToolUseBlock.input.status) {
            case 'completed':
              // v2.4.1: Capture actual outcome description as task result
              // This persists the AI's description of what was accomplished
              // so orchestrator can include it in context for subsequent steps
              await this.tasksService.update(taskId, {
                status: TaskStatus.COMPLETED,
                completedAt: new Date(),
                result: {
                  summary: setTaskStatusToolUseBlock.input.description,
                  completedAt: new Date().toISOString(),
                },
              });
              // v2.2.5: Clear lease on completion
              await this.tasksService.clearLease(taskId);
              // v2.2.10: Stop heartbeat on task completion
              this.taskControllerService.stopHeartbeat(taskId);
              break;
            case 'needs_help':
              const rawErrorCode = (setTaskStatusToolUseBlock.input as any)
                ?.errorCode;
              const requestedErrorCode = parseNeedsHelpErrorCode(rawErrorCode);
              const detailsRaw = (setTaskStatusToolUseBlock.input as any)
                ?.details;
              const details =
                detailsRaw && typeof detailsRaw === 'object'
                  ? (detailsRaw as Record<string, unknown>)
                  : undefined;

              let errorCode =
                requestedErrorCode ?? 'CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP';

              // Strategy prompts must never block execution; treat generic asks as contract violations.
              if (errorCode === 'AGENT_REQUESTED_HELP') {
                errorCode = 'CONTRACT_VIOLATION_STRATEGY_AS_HELP';
              }

              const mergedDetails: Record<string, unknown> = {
                ...(details || {}),
                ...(typeof rawErrorCode === 'string' && rawErrorCode.trim()
                  ? { rawErrorCode: rawErrorCode.trim() }
                  : {}),
              };

              await this.tasksService.update(taskId, {
                status: TaskStatus.NEEDS_HELP,
                result: buildNeedsHelpResult({
                  errorCode,
                  message: setTaskStatusToolUseBlock.input.description,
                  details:
                    Object.keys(mergedDetails).length > 0
                      ? mergedDetails
                      : undefined,
                }),
              });
              // v2.2.5: Clear lease when escalating to user
              await this.tasksService.clearLease(taskId);
              // v2.2.10: Stop heartbeat when escalating to user
              this.taskControllerService.stopHeartbeat(taskId);
              break;
          }
        }

        // Schedule the next iteration without blocking
        // v2.0.28: Use safe wrapper to catch async errors
        if (this.isProcessing) {
          this.scheduleNextIteration(taskId);
        }
      } catch (error: any) {
        if (error?.name === 'BytebotAgentInterrupt') {
          this.logger.warn(
            `[${iterationId}] Processing aborted for task ID: ${taskId}`,
          );
        } else {
          this.logger.error(
            `[${iterationId}] Error during task processing iteration for task ID: ${taskId} - ${error.message}`,
            error.stack,
          );

          const llmErrorType =
            typeof error?.llmErrorType === 'string'
              ? error.llmErrorType
              : undefined;
          const errorMessage = String(error?.message || 'Unknown error');

          // Error taxonomy: connection errors and provider unavailability are INFRA, not semantic.
          // Prefer machine signals (llmErrorType), fallback to conservative string patterns.
          const infraLlmTypes = new Set([
            'TIMEOUT',
            'NETWORK',
            'SERVER_ERROR',
            'RATE_LIMIT',
            'OVERLOADED',
            'UNKNOWN',
          ]);

          const lower = errorMessage.toLowerCase();
          const isInfra =
            (llmErrorType && infraLlmTypes.has(llmErrorType)) ||
            lower.includes('[infra]') ||
            lower.includes('econnrefused') ||
            lower.includes('etimedout') ||
            lower.includes('enotfound') ||
            lower.includes('econnreset') ||
            lower.includes('socket hang up') ||
            lower.includes('fetch failed') ||
            lower.includes('network') ||
            lower.includes('connection refused') ||
            lower.includes('service unavailable') ||
            lower.includes('bad gateway') ||
            lower.includes('circuit breaker open');

          const persistedError =
            isInfra && !lower.includes('[infra]')
              ? `[INFRA] ${errorMessage}`
              : errorMessage;

          await this.tasksService.update(taskId, {
            status: TaskStatus.FAILED,
            error: persistedError,
            result: {
              errorCategory: isInfra ? 'INFRA' : 'SEMANTIC',
              llmErrorType: llmErrorType || null,
              attempts:
                typeof error?.attempts === 'number'
                  ? error.attempts
                  : undefined,
              durationMs:
                typeof error?.durationMs === 'number'
                  ? error.durationMs
                  : undefined,
            },
          });
          // v2.2.5: Clear lease on failure
          await this.tasksService.clearLease(taskId);
          // v2.2.10: Stop heartbeat on task failure
          this.taskControllerService.stopHeartbeat(taskId);
          this.isProcessing = false;
          this.currentTaskId = null;
        }
      }

      this.logger.debug(
        `[${iterationId}] Iteration completed for task ${taskId}`,
      );
    }); // End of runExclusive
  }

  private async performDesktopUiRepair(input: {
    taskId: string;
    desktopUrl: string;
    actionContext: ActionContext;
    trigger: 'loop' | 'blocked_click';
    triggerDetails?: Record<string, unknown>;
    service: BytebotAgentService;
    model: BytebotAgentModel;
    generatedToolResults: MessageContentBlock[];
  }): Promise<{
    shortCircuitReason:
      | 'ui_repair_esc'
      | 'ui_repair_close_click'
      | 'takeover_required';
  }> {
    const { desktopUrl, actionContext } = input;

    const now = Date.now();

    const extractBucketKeyFromSignature = (
      signature?: unknown,
    ): string | null => {
      if (typeof signature !== 'string') return null;
      const match = signature.match(/bucket=([0-9]+,[0-9]+)/);
      return match ? match[1] : null;
    };

    const getOrStartEpisode = (): DesktopUiRepairEpisode => {
      const existing = this.desktopUiRepairEpisode;
      if (
        existing &&
        existing.startedAtMs > 0 &&
        now - existing.startedAtMs <= DESKTOP_LOOP_REPAIR_EPISODE_MAX_MS
      ) {
        return existing;
      }

      const nextEpisode: DesktopUiRepairEpisode = {
        episodeId: ++this.desktopUiRepairEpisodeSeq,
        startedAtMs: now,
        anchorHash: this.lastScreenshotHash,
        escUsed: false,
        closeClickUsed: false,
        progressCandidateHash: null,
        progressCandidateCount: 0,
      };
      this.desktopUiRepairEpisode = nextEpisode;
      return nextEpisode;
    };

    const buildLoopContext = () => {
      const rule =
        typeof input.triggerDetails?.rule === 'string'
          ? input.triggerDetails.rule
          : null;
      const signature =
        typeof input.triggerDetails?.signature === 'string'
          ? input.triggerDetails.signature
          : null;

      const bucket =
        typeof (input.triggerDetails as any)?.bucketKey === 'string'
          ? String((input.triggerDetails as any).bucketKey)
          : extractBucketKeyFromSignature(signature);

      return {
        trigger: input.trigger,
        rule,
        bucket,
      };
    };

    const takeover = (details: Record<string, unknown>) => {
      if (!this.pendingDesktopNeedsHelp) {
        const episode = getOrStartEpisode();
        const loop = buildLoopContext();
        const attempt2ErrorRaw =
          (details as any)?.attempt2 &&
          typeof (details as any).attempt2 === 'object'
            ? (details as any).attempt2.error
            : null;
        const attempt2Error =
          typeof attempt2ErrorRaw === 'string' ? attempt2ErrorRaw : null;

        const repair = {
          attempt1: episode.escUsed
            ? 'esc'
            : DESKTOP_LOOP_REPAIR_ENABLED
              ? 'skipped'
              : 'disabled',
          attempt2: attempt2Error
            ? attempt2Error === 'no_progress_after_click'
              ? 'failed'
              : 'invalid'
            : episode.closeClickUsed
              ? 'close_click'
              : DESKTOP_LOOP_REPAIR_ENABLED &&
                  DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED
                ? 'skipped'
                : 'disabled',
        };

        this.pendingDesktopNeedsHelp = buildNeedsHelpResult({
          errorCode: 'DESKTOP_TAKEOVER_REQUIRED',
          details: {
            reason: 'UI_BLOCKED_POPUP',
            loop,
            repair,
            ...details,
          },
        });
        this.eventEmitter.emit('desktop.interrupt', {
          reasonCode: 'DESKTOP_TAKEOVER_REQUIRED',
        });
      }
      return { shortCircuitReason: 'takeover_required' as const };
    };

    if (!DESKTOP_LOOP_REPAIR_ENABLED) {
      return takeover({
        trigger: input.trigger,
        triggerDetails: input.triggerDetails,
        repairEnabled: false,
        repairAttempt2Enabled: DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED,
      });
    }

    // Attempt 1: Esc once (tap) then force replan.
    const episode = getOrStartEpisode();

    if (!episode.escUsed) {
      const beforeHash = this.lastScreenshotHash;
      episode.escUsed = true;

      this.desktopUiRepairInProgress = true;
      this.eventEmitter.emit('desktop.ui_repair.attempt', {
        attempt: 'esc',
        trigger: input.trigger,
      });

      try {
        const toolUseId = `ui_repair_esc_${Date.now()}`;
        const escBlock = {
          type: MessageContentType.ToolUse,
          id: toolUseId,
          name: 'computer_type_keys',
          input: { keys: ['Escape'], delay: 75 },
        } as any;

        const escResult = await handleComputerToolUse(
          escBlock,
          this.logger,
          actionContext,
        );

        const content = Array.isArray((escResult as any).content)
          ? ((escResult as any).content as any[])
          : [];

        const images = content.filter(
          (c) =>
            c && typeof c === 'object' && c.type === MessageContentType.Image,
        );

        input.generatedToolResults.push({
          type: MessageContentType.Text,
          text: '[System] Desktop safety repair: pressed Escape to dismiss a potential modal/popup. Replan from the updated screenshot.',
        } as any);

        if (images.length > 0) {
          input.generatedToolResults.push(...(images as any));
        }

        const afterHash = this.lastScreenshotHash;
        const dist =
          beforeHash && afterHash
            ? hammingDistanceHex(beforeHash, afterHash)
            : null;
        const success =
          typeof dist === 'number' && Number.isFinite(dist)
            ? dist > DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING
            : false;

        this.eventEmitter.emit('desktop.ui_repair.result', {
          attempt: 'esc',
          outcome: success ? 'success' : 'failure_no_change',
          trigger: input.trigger,
        });
      } finally {
        this.desktopUiRepairInProgress = false;
        // Reset loop detector after repair so we don't instantly re-trigger on old history.
        this.desktopLoopDetector = new DesktopLoopDetector();
      }

      return { shortCircuitReason: 'ui_repair_esc' };
    }

    // Attempt 2: single-shot "close/dismiss click" (bounded).
    if (DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED && !episode.closeClickUsed) {
      episode.closeClickUsed = true;
      const beforeHash = this.lastScreenshotHash;

      this.desktopUiRepairInProgress = true;
      this.eventEmitter.emit('desktop.ui_repair.attempt', {
        attempt: 'close_click',
        trigger: input.trigger,
      });

      try {
        // Capture screenshot for the classifier.
        const screenshotToolUseId = `ui_repair_shot_${Date.now()}`;
        const shotBlock = {
          type: MessageContentType.ToolUse,
          id: screenshotToolUseId,
          name: 'computer_screenshot',
          input: {},
        } as any;

        const shotResult = await handleComputerToolUse(
          shotBlock,
          this.logger,
          actionContext,
        );

        const shotContent = Array.isArray((shotResult as any).content)
          ? ((shotResult as any).content as any[])
          : [];

        const firstImage = shotContent.find(
          (c) =>
            c && typeof c === 'object' && c.type === MessageContentType.Image,
        );

        const screenshotBase64 =
          firstImage?.source && typeof firstImage.source.data === 'string'
            ? (firstImage.source.data as string)
            : null;

        if (!screenshotBase64) {
          this.eventEmitter.emit('desktop.ui_repair.result', {
            attempt: 'close_click',
            outcome: 'failure_invalid',
            trigger: input.trigger,
          });
          return takeover({
            trigger: input.trigger,
            triggerDetails: input.triggerDetails,
            attempt2: { error: 'screenshot_missing' },
          });
        }

        const dims = decodePngDimensionsFromBase64(screenshotBase64);
        if (!dims) {
          this.eventEmitter.emit('desktop.ui_repair.result', {
            attempt: 'close_click',
            outcome: 'failure_invalid',
            trigger: input.trigger,
          });
          return takeover({
            trigger: input.trigger,
            triggerDetails: input.triggerDetails,
            attempt2: { error: 'screenshot_dimensions_unavailable' },
          });
        }

        const classifierSystem = buildUiRepairClassifierSystemPrompt();
        const classifierMessages = [
          buildUiRepairClassifierMessage({
            taskId: input.taskId,
            screenshotBase64Png: screenshotBase64,
          }),
        ];

        const classifierResponse = await input.service.generateMessage(
          classifierSystem,
          classifierMessages,
          input.model.name,
          { useTools: false, signal: this.abortController?.signal },
        );

        const textBlocks = classifierResponse.contentBlocks.filter(
          (b) => b.type === MessageContentType.Text,
        ) as any[];
        const combinedText = textBlocks
          .map((b) => b.text)
          .join('\n')
          .trim();

        const parsed = parseUiRepairCandidate(combinedText);
        if (!parsed.ok) {
          this.eventEmitter.emit('desktop.ui_repair.result', {
            attempt: 'close_click',
            outcome: 'failure_invalid',
            trigger: input.trigger,
          });
          return takeover({
            trigger: input.trigger,
            triggerDetails: input.triggerDetails,
            attempt2: {
              error: 'classifier_parse_failed',
              detail: parsed.error,
            },
          });
        }

        const validation = validateUiRepairCandidate({
          candidate: parsed.candidate,
          dimensions: dims,
          minConfidence: DESKTOP_LOOP_REPAIR_ATTEMPT2_MIN_CONFIDENCE,
        });

        if (!validation.ok) {
          this.eventEmitter.emit('desktop.ui_repair.result', {
            attempt: 'close_click',
            outcome: 'failure_invalid',
            trigger: input.trigger,
          });
          return takeover({
            trigger: input.trigger,
            triggerDetails: input.triggerDetails,
            attempt2: { error: 'candidate_rejected', detail: validation.error },
          });
        }

        // Execute exactly one click at the suggested point.
        const clickToolUseId = `ui_repair_click_${Date.now()}`;
        const clickBlock = {
          type: MessageContentType.ToolUse,
          id: clickToolUseId,
          name: 'computer_click_mouse',
          input: {
            coordinates: {
              x: Math.round(parsed.candidate.x),
              y: Math.round(parsed.candidate.y),
            },
            button: 'left',
            clickCount: 1,
          },
        } as any;

        const clickResult = await handleComputerToolUse(
          clickBlock,
          this.logger,
          actionContext,
        );

        const clickContent = Array.isArray((clickResult as any).content)
          ? ((clickResult as any).content as any[])
          : [];

        const clickImages = clickContent.filter(
          (c) =>
            c && typeof c === 'object' && c.type === MessageContentType.Image,
        );

        input.generatedToolResults.push({
          type: MessageContentType.Text,
          text: '[System] Desktop safety repair: attempted a single close/dismiss click for a blocking overlay. Replan from the updated screenshot.',
        } as any);

        if (clickImages.length > 0) {
          input.generatedToolResults.push(...(clickImages as any));
        }

        const afterHash = this.lastScreenshotHash;
        const dist =
          beforeHash && afterHash
            ? hammingDistanceHex(beforeHash, afterHash)
            : null;
        const success =
          typeof dist === 'number' && Number.isFinite(dist)
            ? dist > DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING
            : false;

        this.eventEmitter.emit('desktop.ui_repair.result', {
          attempt: 'close_click',
          outcome: success ? 'success' : 'failure_no_change',
          trigger: input.trigger,
        });

        if (!success) {
          return takeover({
            trigger: input.trigger,
            triggerDetails: input.triggerDetails,
            attempt2: {
              error: 'no_progress_after_click',
              rationale: parsed.candidate.rationaleCode,
            },
          });
        }
      } finally {
        this.desktopUiRepairInProgress = false;
        this.desktopLoopDetector = new DesktopLoopDetector();
      }

      return { shortCircuitReason: 'ui_repair_close_click' };
    }

    // Repairs exhausted → takeover.
    return takeover({
      trigger: input.trigger,
      triggerDetails: input.triggerDetails,
      repair: {
        attempt2Enabled: DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED,
      },
    });
  }

  private handleDesktopSafetyAction(action: ActionResult): void {
    if (this.pendingDesktopNeedsHelp) {
      return;
    }

    // Track last observed screenshot hash to gate "no progress" blocking and reset repair budgets.
    const prevHash = this.lastScreenshotHash;
    const nextHash =
      typeof action.screenshotHash === 'string' ? action.screenshotHash : null;

    // Episode expiry: avoid holding "attempt used" state forever.
    if (
      this.desktopUiRepairEpisode &&
      Date.now() - this.desktopUiRepairEpisode.startedAtMs >
        DESKTOP_LOOP_REPAIR_EPISODE_MAX_MS
    ) {
      this.desktopUiRepairEpisode = null;
    }

    // Confirm progress conservatively: require the UI to move away from the episode anchor AND
    // remain stable for at least 2 observations. This prevents animated jitter from resetting
    // the repair ladder and causing repeated Esc.
    if (this.desktopUiRepairEpisode?.anchorHash && nextHash) {
      const distFromAnchor = hammingDistanceHex(
        this.desktopUiRepairEpisode.anchorHash,
        nextHash,
      );

      if (distFromAnchor > DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING) {
        const candidate = this.desktopUiRepairEpisode.progressCandidateHash;
        if (
          candidate &&
          hammingDistanceHex(candidate, nextHash) <=
            DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING
        ) {
          this.desktopUiRepairEpisode.progressCandidateCount++;
        } else {
          this.desktopUiRepairEpisode.progressCandidateHash = nextHash;
          this.desktopUiRepairEpisode.progressCandidateCount = 1;
        }

        if (this.desktopUiRepairEpisode.progressCandidateCount >= 2) {
          this.blockedClickBuckets.clear();
          this.desktopUiRepairEpisode = null;
        }
      } else {
        this.desktopUiRepairEpisode.progressCandidateHash = null;
        this.desktopUiRepairEpisode.progressCandidateCount = 0;
      }
    }

    if (nextHash) {
      this.lastScreenshotHash = nextHash;
    }

    // If a click produced no meaningful change, block repeating the same click bucket until progress.
    if (
      action.actionType === 'computer_click_mouse' &&
      action.coordinates &&
      prevHash &&
      nextHash
    ) {
      const dist = hammingDistanceHex(prevHash, nextHash);
      if (dist <= DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING) {
        const bx = Math.floor(
          action.coordinates.x / DESKTOP_LOOP_COORDINATE_BUCKET_PX,
        );
        const by = Math.floor(
          action.coordinates.y / DESKTOP_LOOP_COORDINATE_BUCKET_PX,
        );
        const bucketKey = `${bx},${by}`;
        const existing = this.blockedClickBuckets.get(bucketKey);
        this.blockedClickBuckets.set(bucketKey, {
          sinceHash: nextHash,
          blockedAtMs: Date.now(),
          count: (existing?.count || 0) + 1,
        });
      }
    }

    const isUiAffecting = DESKTOP_OBSERVATION_REQUIRED_TOOLS.has(
      action.actionType,
    );

    const hasObservation = action.screenshotCaptured === true;

    if (hasObservation || action.actionType === 'computer_screenshot') {
      this.desktopActionsWithoutObservation = 0;
    } else if (isUiAffecting) {
      this.desktopActionsWithoutObservation++;
    }

    if (
      isUiAffecting &&
      this.desktopActionsWithoutObservation >=
        DESKTOP_MAX_ACTIONS_WITHOUT_OBSERVATION
    ) {
      // Gold rule: do not continue “blind”. Instead of immediately interrupting, force an observation.
      // If the forced screenshot fails, we fall back to the typed interrupt path.
      this.pendingForcedScreenshot = true;
      this.pendingForcedScreenshotReason = 'actions_budget';
      this.eventEmitter.emit('desktop.forced_screenshot', {
        reason: 'actions_budget',
      });
      return;
    }

    if (!isUiAffecting || typeof action.actionSignature !== 'string') {
      return;
    }

    // During a self-repair action, do not schedule nested repairs/interrupts.
    if (this.desktopUiRepairInProgress) {
      return;
    }

    const loop = this.desktopLoopDetector.record({
      atMs: Date.now(),
      signature: action.actionSignature,
      screenshotHash: action.screenshotHash ?? null,
    });

    if (loop.interrupt) {
      this.eventEmitter.emit('desktop.loop.detected', {
        rule: loop.rule || 'unknown',
      });

      // Schedule a bounded repair (executed in the tool loop). Avoid stacking multiple repairs.
      if (!this.pendingDesktopRepairTrigger) {
        this.pendingDesktopRepairTrigger = {
          trigger: 'loop',
          details: {
            rule: loop.rule || 'unknown',
            signature: loop.signature,
            count: loop.count,
          },
        };
      }
      return;
    }
  }

  async stopProcessing(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    const taskId = this.currentTaskId;
    this.logger.log(`Stopping execution of task ${taskId}`);

    // Signal any in-flight async operations to abort
    this.abortController?.abort();

    await this.inputCaptureService.stop();

    // Phase 6.4: Stop heartbeat and flush action logs
    if (taskId) {
      this.taskControllerService.stopHeartbeat(taskId);

      // Flush any pending action logs
      try {
        await this.actionLoggingService.flushActions(taskId);
      } catch (error: any) {
        this.logger.warn(
          `Failed to flush action logs for ${taskId}: ${error.message}`,
        );
      }
    }

    this.isProcessing = false;
    this.currentTaskId = null;
  }
}
