/**
 * Execution Activities - Step execution and verification
 *
 * These activities handle the execution of individual steps by dispatching
 * tasks to ByteBot agents and verifying the results.
 *
 * Phase 11.3: Updated to route step dispatch through orchestrator's internal API.
 * The orchestrator uses its TaskDispatchService to dispatch tasks to bytebot-agent:9991.
 *
 * Architecture:
 * Temporal Worker → Orchestrator (/api/v1/internal/dispatch-step)
 *                 → TaskDispatchService → bytebot-agent:9991/tasks
 *                 → Agent polls and claims tasks
 *                 → Orchestrator polls for completion
 *                 → Results returned to Temporal Worker
 */

import { Context } from '@temporalio/activity';
import axios from 'axios';

import type {
  ExecuteStepInput,
  ExecuteStepOutput,
  VerifyStepInput,
  VerifyStepOutput,
} from '../types/goal-run.types';

// ============================================================================
// Configuration
// ============================================================================

// Phase 11.3: Orchestrator is the primary endpoint for step dispatch
// The orchestrator's internal API routes requests through TaskDispatchService
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://bytebot-workflow-orchestrator:8080';
const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS ?? '300000', 10); // 5 min
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '10000', 10); // 10s
const DISPATCH_TIMEOUT_MS = parseInt(process.env.DISPATCH_TIMEOUT_MS ?? '30000', 10); // 30s for dispatch
const STATUS_POLL_INTERVAL_MS = parseInt(process.env.STATUS_POLL_INTERVAL_MS ?? '5000', 10); // 5s poll interval

// ============================================================================
// Activity Interface
// ============================================================================

export interface ExecutionActivities {
  executeStep(input: ExecuteStepInput): Promise<ExecuteStepOutput>;
  verifyStep(input: VerifyStepInput): Promise<VerifyStepOutput>;
  classifyFailure(error: Error): Promise<{
    category: 'TRANSIENT' | 'SEMANTIC' | 'PERMANENT';
    retryable: boolean;
    suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
  }>;
}

// ============================================================================
// Activity Implementations
// ============================================================================

/**
 * Executes a single step by dispatching a task to a ByteBot agent.
 *
 * Key features:
 * - Periodic heartbeats to prevent timeout
 * - Captures actual outcome for context (Manus pattern)
 * - Extracts knowledge gained during execution
 *
 * Phase 11.3: Routes dispatch through orchestrator's internal API.
 * The orchestrator uses TaskDispatchService to:
 * 1. Create task in bytebot-agent system
 * 2. Poll for task completion
 * 3. Update checklist items and emit events
 */
export async function executeStep(input: ExecuteStepInput): Promise<ExecuteStepOutput> {
  const context = Context.current();
  const abortController = new AbortController();

  // Set up periodic heartbeat
  const heartbeatInterval = setInterval(() => {
    context.heartbeat({
      step: input.step.stepNumber,
      status: 'executing',
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    context.heartbeat({ step: input.step.stepNumber, status: 'starting' });

    // Phase 11.3: Dispatch step via orchestrator's internal API
    // This routes through TaskDispatchService which handles:
    // - Idempotent task creation in bytebot-agent
    // - Task routing to bytebot-agent:9991
    // - Activity event emission for UI updates
    const dispatchResponse = await axios.post<{
      success: boolean;
      taskId?: string;
      status?: 'PENDING' | 'DISPATCHED';
      error?: string;
    }>(
      `${ORCHESTRATOR_URL}/api/v1/internal/dispatch-step`,
      {
        goalRunId: input.goalRunId,
        tenantId: input.tenantId,
        step: {
          stepNumber: input.step.stepNumber,
          description: input.step.description,
          expectedOutcome: input.step.expectedOutcome,
          isHighRisk: input.step.isHighRisk,
          dependencies: input.step.dependencies,
          // suggestedTools and requiresDesktop are determined by the orchestrator
          // based on step analysis during dispatch
        },
        workspaceId: input.workspaceId,
        context: {
          previousStepOutcome: input.context?.previousStepOutcome,
          accumulatedKnowledge: input.context?.accumulatedKnowledge,
        },
        idempotencyKey: `${input.goalRunId}-step-${input.step.stepNumber}`,
      },
      {
        timeout: DISPATCH_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'true',
        },
        signal: abortController.signal,
      }
    );

    if (!dispatchResponse.data.success || !dispatchResponse.data.taskId) {
      clearInterval(heartbeatInterval);
      return {
        success: false,
        outcome: '',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        waitingForUserInput: false,
        error: dispatchResponse.data.error || 'Failed to dispatch step',
      };
    }

    const taskId = dispatchResponse.data.taskId;
    context.heartbeat({ step: input.step.stepNumber, status: 'dispatched', taskId });

    // Poll orchestrator's internal API for task completion
    // The orchestrator's TaskDispatchService polls the agent and updates status
    const result = await pollForTaskCompletionViaOrchestrator(
      taskId,
      input.tenantId,
      EXECUTION_TIMEOUT_MS,
      (status) => {
        context.heartbeat({
          step: input.step.stepNumber,
          status: 'polling',
          taskStatus: status,
        });
      }
    );

    clearInterval(heartbeatInterval);

    if (result.status === 'COMPLETED') {
      // Extract knowledge from the execution result
      const knowledgeGained = extractKnowledge(result.output);

      return {
        success: true,
        outcome: result.output?.summary ?? result.output?.result ?? 'Step completed successfully',
        artifacts: result.output?.artifacts ?? [],
        knowledgeGained,
        needsApproval: false,
        waitingForUserInput: false,
      };
    } else if (result.status === 'WAITING_USER_INPUT') {
      return {
        success: false,
        outcome: result.output?.summary ?? 'Waiting for user input',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        waitingForUserInput: true,
      };
    } else {
      return {
        success: false,
        outcome: '',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        waitingForUserInput: false,
        error: result.error ?? 'Step execution failed',
      };
    }
  } catch (error) {
    clearInterval(heartbeatInterval);

    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for specific error types
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNREFUSED') {
        return {
          success: false,
          outcome: '',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
          waitingForUserInput: false,
          error: `Orchestrator service unavailable: ${errorMessage}`,
        };
      }
      if (error.response?.status === 429) {
        return {
          success: false,
          outcome: '',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
          waitingForUserInput: false,
          error: 'Rate limited, please retry',
        };
      }
      if (error.response?.status === 403) {
        return {
          success: false,
          outcome: '',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
          waitingForUserInput: false,
          error: 'Internal authentication failed',
        };
      }
    }

    return {
      success: false,
      outcome: '',
      artifacts: [],
      knowledgeGained: [],
      needsApproval: false,
      waitingForUserInput: false,
      error: errorMessage,
    };
  }
}

/**
 * Verifies that a step was executed correctly.
 * Uses LLM to compare expected vs actual outcome.
 */
export async function verifyStep(input: VerifyStepInput): Promise<VerifyStepOutput> {
  const context = Context.current();
  context.heartbeat('Starting step verification');

  // If no expected outcome, auto-verify based on success
  if (!input.step.expectedOutcome) {
    return {
      verified: input.executionResult.success,
      verificationDetails: input.executionResult.success
        ? 'Step completed successfully (no expected outcome specified)'
        : 'Step failed',
      suggestReplan: !input.executionResult.success,
      replanReason: input.executionResult.error,
    };
  }

  try {
    // Call orchestrator's verification endpoint
    const response = await axios.post<{
      verified: boolean;
      verificationDetails: string;
      suggestReplan: boolean;
      replanReason?: string;
    }>(
      `${ORCHESTRATOR_URL}/api/v1/internal/verify`,
      {
        goalRunId: input.goalRunId,
        tenantId: input.tenantId,
        step: input.step,
        expectedOutcome: input.step.expectedOutcome,
        actualOutcome: input.executionResult.outcome,
        success: input.executionResult.success,
        error: input.executionResult.error,
      },
      {
        timeout: 60000,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'true',
        },
      }
    );

    context.heartbeat('Verification complete');

    return {
      verified: response.data.verified,
      verificationDetails: response.data.verificationDetails,
      suggestReplan: response.data.suggestReplan,
      replanReason: response.data.replanReason,
    };
  } catch (error) {
    // Fallback: simple verification based on success flag
    return {
      verified: input.executionResult.success,
      verificationDetails: `Fallback verification: ${input.executionResult.success ? 'success' : 'failed'}`,
      suggestReplan: !input.executionResult.success,
      replanReason: input.executionResult.error,
    };
  }
}

/**
 * Classifies a failure according to Google SRE patterns.
 * Used to determine retry strategy.
 */
export async function classifyFailure(error: Error): Promise<{
  category: 'TRANSIENT' | 'SEMANTIC' | 'PERMANENT';
  retryable: boolean;
  suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
}> {
  const message = error.message.toLowerCase();

  // Transient failures (retry with backoff)
  if (
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('unavailable')
  ) {
    return {
      category: 'TRANSIENT',
      retryable: true,
      suggestedAction: 'RETRY',
    };
  }

  // Semantic failures (need replanning)
  if (
    message.includes('step failed') ||
    message.includes('validation') ||
    message.includes('assertion') ||
    message.includes('unexpected') ||
    message.includes('wrong approach')
  ) {
    return {
      category: 'SEMANTIC',
      retryable: false,
      suggestedAction: 'REPLAN',
    };
  }

  // Permanent failures (cannot recover)
  if (
    message.includes('permission denied') ||
    message.includes('not found') ||
    message.includes('deleted') ||
    message.includes('cancelled') ||
    message.includes('budget exhausted')
  ) {
    return {
      category: 'PERMANENT',
      retryable: false,
      suggestedAction: 'FAIL',
    };
  }

  // Default to semantic (trigger replan)
  return {
    category: 'SEMANTIC',
    retryable: false,
    suggestedAction: 'REPLAN',
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

interface TaskResult {
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'WAITING_USER_INPUT';
  output?: {
    summary?: string;
    result?: string;
    artifacts?: string[];
  };
  error?: string;
}

/**
 * Phase 11.3: Polls for task completion via orchestrator's internal API.
 *
 * The orchestrator's TaskDispatchService maintains task status and polls
 * the bytebot-agent for updates. We query the orchestrator's internal API
 * which provides a unified view of task status.
 */
async function pollForTaskCompletionViaOrchestrator(
  taskId: string,
  tenantId: string,
  timeoutMs: number,
  onStatusChange: (status: string) => void
): Promise<TaskResult> {
  const startTime = Date.now();
  let pollInterval = STATUS_POLL_INTERVAL_MS; // Start at configured interval
  const maxPollInterval = 10000; // Max 10s
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 10;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await axios.get<{
        status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_USER_INPUT';
        output?: {
          summary?: string;
          result?: string;
          artifacts?: string[];
        };
        error?: string;
      }>(`${ORCHESTRATOR_URL}/api/v1/internal/task-status/${taskId}`, {
        headers: {
          'X-Tenant-Id': tenantId,
          'X-Internal-Request': 'true',
        },
        timeout: 10000,
      });

      // Reset error counter on success
      consecutiveErrors = 0;
      onStatusChange(response.data.status);

      if (response.data.status === 'COMPLETED') {
        return {
          status: 'COMPLETED',
          output: response.data.output,
        };
      }

      if (response.data.status === 'FAILED') {
        return {
          status: 'FAILED',
          error: response.data.error ?? 'Task failed',
        };
      }

      if (response.data.status === 'WAITING_USER_INPUT') {
        return {
          status: 'WAITING_USER_INPUT',
          output: response.data.output,
        };
      }

      // Still running, wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      // Gradually increase poll interval for long-running tasks
      pollInterval = Math.min(pollInterval * 1.2, maxPollInterval);
    } catch (error) {
      consecutiveErrors++;

      // If too many consecutive errors, return failure
      if (consecutiveErrors >= maxConsecutiveErrors) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          status: 'FAILED',
          error: `Polling failed after ${maxConsecutiveErrors} consecutive errors: ${errorMessage}`,
        };
      }

      // Network error during polling, wait with exponential backoff and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
      pollInterval = Math.min(pollInterval * 2, maxPollInterval);
    }
  }

  return {
    status: 'TIMEOUT',
    error: `Task did not complete within ${timeoutMs}ms`,
  };
}

/**
 * Extracts knowledge/facts from execution output.
 * Used to build context for subsequent steps (Anthropic pattern).
 */
function extractKnowledge(output?: {
  summary?: string;
  result?: string;
  facts?: string[];
  discoveries?: string[];
}): string[] {
  const knowledge: string[] = [];

  if (output?.facts) {
    knowledge.push(...output.facts);
  }

  if (output?.discoveries) {
    knowledge.push(...output.discoveries);
  }

  // Extract key information from summary
  if (output?.summary) {
    // Simple heuristic: look for "found", "discovered", "confirmed", "learned"
    const keyPhrases = output.summary.match(
      /(found|discovered|confirmed|learned|identified|determined)[^.]+\./gi
    );
    if (keyPhrases) {
      knowledge.push(...keyPhrases.map((p) => p.trim()));
    }
  }

  return knowledge;
}
