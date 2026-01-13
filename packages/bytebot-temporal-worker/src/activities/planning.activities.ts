/**
 * Planning Activities - LLM-powered goal planning for Butler Vantage
 *
 * These activities call the Butler Vantage planner service to generate step-by-step
 * plans for goal execution. Plans are designed for a DESKTOP-BASED agent that
 * operates through computer-use tools (click, type, scroll, screenshot).
 *
 * Phase 10.1: Enhanced with metrics for LLM call tracking
 * Phase 11.0: Added circuit breaker, enhanced heartbeats, in-house model flow
 * Phase 13.0: Fixed fallback model configuration and improved circuit breaker recovery
 * Phase 13.3: Enhanced planning prompt with desktop agent capability awareness
 * Phase 14.2: Fixed overly granular planning - clarified task-level vs action-level steps
 *
 * Model Flow (Phase 13):
 * - Planning (planGoal, refinePlan): Uses PLANNING_MODEL (default: gpt-oss-120b)
 * - Execution (via activities): Uses EXECUTION_MODEL (default: qwen3-vl-32b when available)
 * - Fallback: Uses FALLBACK_MODEL (default: claude-sonnet-4-5 - verified in LiteLLM)
 *
 * Agent Paradigm (Phase 13.3):
 * - Butler Vantage is a desktop-based agent operating in a virtual desktop environment
 * - Uses computer-use tools: click, type, key, scroll, screenshot, move, drag, cursor_position
 * - Interacts with websites through a browser within the desktop
 * - Cannot make direct API calls - all data retrieval is through visual observation
 *
 * Planning Granularity (Phase 14.2):
 * - Steps are TASK-LEVEL (meaningful sub-goals), NOT ACTION-LEVEL (individual mouse/keyboard actions)
 * - Example GOOD step: "Navigate to google.com in the browser"
 * - Example BAD step: "Click address bar, type URL, press Enter"
 * - The execution engine handles translating task-level steps into individual actions
 */

import { Context } from '@temporalio/activity';

import type {
  PlanGoalInput,
  PlanGoalOutput,
  Step,
} from '../types/goal-run.types';

// Phase 10.1: Metrics integration
import { getMetricsService } from '../metrics';

// Phase 11: Circuit breaker for resilient HTTP calls
import {
  resilientRequest,
  LLM_CIRCUIT_BREAKER_CONFIG,
  ORCHESTRATOR_CIRCUIT_BREAKER_CONFIG,
} from '../utils/circuit-breaker';

// ============================================================================
// Configuration
// ============================================================================

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL ?? 'http://bytebot-workflow-orchestrator:3000';
const LLM_PROXY_URL = process.env.LLM_PROXY_URL ?? 'http://bytebot-llm-proxy:3000';
const LLM_API_KEY = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const PLANNING_TIMEOUT_MS = parseInt(process.env.PLANNING_TIMEOUT_MS ?? '120000', 10);

// Phase 13: In-house model configuration with proper fallback
// Use gpt-oss-120b for planning (oversight), qwen3-vl-32b for execution (when available)
// Fallback uses claude-sonnet-4-5 which is configured in LiteLLM
const PLANNING_MODEL = process.env.PLANNING_MODEL ?? 'gpt-oss-120b';
const EXECUTION_MODEL = process.env.EXECUTION_MODEL ?? 'qwen3-vl-32b';
// Phase 13: Fixed fallback model - gpt-4 was not in LiteLLM config
// Using claude-sonnet-4-5 as fallback (reliable, available in LiteLLM)
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? 'claude-sonnet-4-5';

// Phase 11: Heartbeat configuration
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.PLANNING_HEARTBEAT_INTERVAL_MS ?? '30000', 10);

// ============================================================================
// Activity Interface
// ============================================================================

export interface PlanningActivities {
  planGoal(input: PlanGoalInput): Promise<PlanGoalOutput>;
  refinePlan(input: { currentPlan: Step[]; feedback: string }): Promise<PlanGoalOutput>;
}

// ============================================================================
// Activity Implementations
// ============================================================================

/**
 * Plans the steps required to achieve a goal.
 * Uses the Butler Vantage planner service or LLM directly.
 *
 * Phase 11: Enhanced with circuit breaker and periodic heartbeats
 * Phase 13.3: Planning prompt now describes desktop agent capabilities
 *
 * @param input - Goal planning input including description and context
 * @returns Structured plan with steps optimized for desktop agent execution
 */
export async function planGoal(input: PlanGoalInput): Promise<PlanGoalOutput> {
  const context = Context.current();
  const metricsService = getMetricsService();
  const startTime = Date.now();

  // Phase 11: Set up periodic heartbeat for long-running planning
  let heartbeatCount = 0;
  const heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    context.heartbeat({
      phase: 'planning',
      goalRunId: input.goalRunId,
      status: 'in_progress',
      heartbeatCount,
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    // Initial heartbeat
    context.heartbeat({
      phase: 'planning',
      goalRunId: input.goalRunId,
      status: 'starting',
      model: PLANNING_MODEL,
      timestamp: new Date().toISOString(),
    });

    // Build planning context with failure history (Manus pattern: "leave wrong turns in context")
    const planningContext = buildPlanningContext(input);

    type InternalPlanResponse =
      | {
          kind: 'PLAN';
          steps: Array<{
            stepNumber: number;
            description: string;
            expectedOutcome?: string;
            isHighRisk?: boolean;
            dependencies?: number[];
            estimatedDurationMs?: number;
          }>;
          planSummary: string;
          estimatedDurationMs?: number;
          confidence?: number;
        }
      | {
          kind: 'GOAL_INTAKE_REQUIRED';
          promptId: string;
          goalSpecId: string;
          reason: string;
        };

    // Phase 11: Use circuit breaker for orchestrator call
    const response = await resilientRequest<InternalPlanResponse>(
      {
        method: 'POST',
        url: `${ORCHESTRATOR_URL}/api/v1/internal/plan`,
        data: {
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
          goalDescription: input.goalDescription,
          context: planningContext,
          constraints: input.constraints,
          // Phase 11: Pass model preference to orchestrator
          preferredModel: PLANNING_MODEL,
        },
        timeout: PLANNING_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'true',
        },
      },
      { ...ORCHESTRATOR_CIRCUIT_BREAKER_CONFIG, enableHeartbeats: false } // We handle heartbeats manually
    );

    clearInterval(heartbeatInterval);

    // Final heartbeat
    context.heartbeat({
      phase: 'planning',
      goalRunId: input.goalRunId,
      status: 'completed',
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });

    // Record metrics
    const durationMs = Date.now() - startTime;
    metricsService?.recordActivityExecution('planning', 'success');
    metricsService?.recordActivityDuration('planning', durationMs);

    if (response.data.kind === 'GOAL_INTAKE_REQUIRED') {
      return {
        kind: 'GOAL_INTAKE_REQUIRED',
        promptId: response.data.promptId,
        goalSpecId: response.data.goalSpecId,
        reason: response.data.reason,
      };
    }

    // Validate and normalize steps
    const steps: Step[] = response.data.steps.map((step, index) => ({
      stepNumber: step.stepNumber ?? index + 1,
      description: step.description,
      expectedOutcome: step.expectedOutcome,
      isHighRisk: step.isHighRisk ?? false,
      dependencies: step.dependencies ?? [],
      estimatedDurationMs: step.estimatedDurationMs,
    }));

    return {
      kind: 'PLAN',
      steps,
      planSummary: response.data.planSummary,
      estimatedDurationMs: response.data.estimatedDurationMs,
      confidence: response.data.confidence,
    };
  } catch (error) {
    clearInterval(heartbeatInterval);

    context.heartbeat({
      phase: 'planning',
      goalRunId: input.goalRunId,
      status: 'fallback',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });

    // Fallback to direct LLM planning if orchestrator fails
    return await fallbackLLMPlanning(input);
  }
}

/**
 * Refines an existing plan based on feedback.
 * Used during replanning after step failures.
 *
 * Phase 11: Enhanced with circuit breaker and periodic heartbeats
 */
export async function refinePlan(input: {
  currentPlan: Step[];
  feedback: string;
  goalRunId?: string;
  tenantId?: string;
}): Promise<PlanGoalOutput> {
  const context = Context.current();
  const metricsService = getMetricsService();
  const startTime = Date.now();

  // Phase 11: Set up periodic heartbeat
  let heartbeatCount = 0;
  const heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    context.heartbeat({
      phase: 'refinement',
      goalRunId: input.goalRunId,
      status: 'in_progress',
      heartbeatCount,
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    context.heartbeat({
      phase: 'refinement',
      goalRunId: input.goalRunId,
      status: 'starting',
      model: PLANNING_MODEL,
      timestamp: new Date().toISOString(),
    });

    // Phase 11: Use circuit breaker for orchestrator call
    const response = await resilientRequest<{
      steps: Array<{
        stepNumber: number;
        description: string;
        expectedOutcome?: string;
        isHighRisk?: boolean;
        dependencies?: number[];
      }>;
      planSummary: string;
      confidence?: number;
    }>(
      {
        method: 'POST',
        url: `${ORCHESTRATOR_URL}/api/v1/internal/refine-plan`,
        data: {
          currentPlan: input.currentPlan,
          feedback: input.feedback,
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
          // Phase 11: Pass model preference
          preferredModel: PLANNING_MODEL,
        },
        timeout: PLANNING_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Request': 'true',
        },
      },
      { ...ORCHESTRATOR_CIRCUIT_BREAKER_CONFIG, enableHeartbeats: false }
    );

    clearInterval(heartbeatInterval);

    // Record metrics
    const durationMs = Date.now() - startTime;
    metricsService?.recordActivityExecution('refinement', 'success');
    metricsService?.recordActivityDuration('refinement', durationMs);

    context.heartbeat({
      phase: 'refinement',
      goalRunId: input.goalRunId,
      status: 'completed',
      durationMs,
      timestamp: new Date().toISOString(),
    });

    const steps: Step[] = response.data.steps.map((step, index) => ({
      stepNumber: step.stepNumber ?? index + 1,
      description: step.description,
      expectedOutcome: step.expectedOutcome,
      isHighRisk: step.isHighRisk ?? false,
      dependencies: step.dependencies ?? [],
    }));

    return {
      kind: 'PLAN',
      steps,
      planSummary: response.data.planSummary,
      confidence: response.data.confidence,
    };
  } catch (error) {
    clearInterval(heartbeatInterval);

    metricsService?.recordActivityExecution('refinement', 'failure');
    metricsService?.recordError('PLAN_REFINEMENT_FAILED', true);

    throw new Error(
      `Plan refinement failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Builds a rich planning context including failure history.
 * Implements the Manus AI pattern: "leave wrong turns in context"
 */
function buildPlanningContext(input: PlanGoalInput): string {
  const parts: string[] = [];

  // Goal description
  parts.push(`## Goal\n${input.goalDescription}`);

  // Previous failures (wrong turns to learn from)
  if (input.previousFailures && input.previousFailures.length > 0) {
    parts.push('\n## Previous Attempts (Learn from these)');
    for (const failure of input.previousFailures) {
      parts.push(`- Step ${failure.stepNumber} failed: ${failure.error}`);
    }
    parts.push('\nPlease create a new plan that avoids these issues.');
  }

  // Accumulated knowledge
  if (input.accumulatedKnowledge && input.accumulatedKnowledge.length > 0) {
    parts.push('\n## Known Information');
    for (const knowledge of input.accumulatedKnowledge) {
      parts.push(`- ${knowledge}`);
    }
  }

  // Constraints
  if (input.constraints) {
    parts.push('\n## Constraints');
    parts.push(`- Maximum steps: ${input.constraints.maxSteps}`);
  }

  return parts.join('\n');
}

/**
 * Fallback LLM planning when orchestrator is unavailable.
 * Calls LLM proxy directly with a structured prompt.
 *
 * Phase 10.1: Enhanced with LLM metrics tracking
 * Phase 11.0: Updated to use in-house gpt-oss-120b model with circuit breaker
 *
 * Model Priority:
 * 1. PLANNING_MODEL (gpt-oss-120b) - In-house, cost-free
 * 2. FALLBACK_MODEL (gpt-4) - External fallback if circuit open
 */
async function fallbackLLMPlanning(input: PlanGoalInput): Promise<PlanGoalOutput> {
  const context = Context.current();
  const metricsService = getMetricsService();
  const startTime = Date.now();

  // Phase 11: Set up periodic heartbeat for long-running LLM calls
  let heartbeatCount = 0;
  const heartbeatInterval = setInterval(() => {
    heartbeatCount++;
    context.heartbeat({
      phase: 'fallback_planning',
      goalRunId: input.goalRunId,
      status: 'waiting_for_llm',
      model: PLANNING_MODEL,
      heartbeatCount,
      elapsedMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    });
  }, HEARTBEAT_INTERVAL_MS);

  context.heartbeat({
    phase: 'fallback_planning',
    goalRunId: input.goalRunId,
    status: 'starting',
    model: PLANNING_MODEL,
    timestamp: new Date().toISOString(),
  });

  // Phase 14.2: Fixed planning prompt with proper granularity guidance
  // Key fix: Clarified "task-level" vs "action-level" steps to prevent overly granular planning
  // Based on industry best practices from Anthropic computer-use, OpenAI Operator, Manus AI, and ReAct
  const planningPrompt = `You are Butler Vantage, a DESKTOP-BASED autonomous agent. You plan and execute tasks by controlling a virtual desktop environment through visual observation and computer-use actions.

## Your Capabilities

You operate within a virtual desktop environment and can:
- **Visual Observation**: Take screenshots to see the current screen state
- **Mouse Control**: Click, double-click, right-click, drag, move cursor to coordinates
- **Keyboard Input**: Type text, press keys, use keyboard shortcuts (Ctrl+C, Alt+Tab, etc.)
- **Scrolling**: Scroll up/down/left/right within windows and web pages
- **Application Interaction**: Open applications, switch windows, interact with UI elements
- **Web Browsing**: Navigate websites, fill forms, click buttons, read content from web pages

## Important Constraints

You CANNOT:
- Make direct API calls to external services (no REST, GraphQL, or programmatic HTTP requests)
- Execute command-line scripts or terminal commands
- Access databases directly
- Read files outside the desktop environment
- Perform actions that require developer/admin tools not visible in the GUI

## CRITICAL: Step Granularity Guidelines

Steps should be **TASK-LEVEL**, not **ACTION-LEVEL**.

### BAD Examples (Too Granular - DO NOT DO THIS):
- "Move cursor to address bar"
- "Click on the address bar"
- "Type 'https://www.google.com'"
- "Press Enter key"
- "Move cursor to search box"

### GOOD Examples (Correct Granularity):
- "Navigate to google.com in the browser"
- "Search for 'cheap flights to Paris' on Google"
- "Fill out the login form with provided credentials"
- "Download the PDF report from the dashboard"

### The Difference:
- **Task-level step**: Accomplishes a meaningful sub-goal (e.g., "Navigate to website")
- **Action-level step**: A single mouse/keyboard action (e.g., "Click", "Type", "Press Enter")

Your steps should be task-level. The execution engine handles the individual mouse/keyboard actions.

## Task to Plan

${buildPlanningContext(input)}

## Response Format

Respond with a JSON object containing:
- steps: Array of { stepNumber, description, expectedOutcome, isHighRisk, dependencies }
- planSummary: Brief description of how you will accomplish this through desktop interactions
- confidence: Number between 0 and 1 (lower if task requires capabilities you don't have)
- capabilityAssessment: Brief note if any part of the task may be difficult or impossible

## Planning Rules

1. **Task-Level Steps**: Each step should accomplish a meaningful sub-goal, NOT a single mouse/keyboard action
2. **Desktop-First**: Every step must be achievable through visual observation and computer-use actions
3. **No API Calls**: Never plan steps that involve "calling an API", "querying a database", or "running a script"
4. **Verifiable Outcomes**: Each step should have an observable outcome (like "website loaded", NOT "cursor moved")
5. **High-Risk Marking**: Mark steps that submit forms, make purchases, send messages, or modify external data as isHighRisk: true
6. **Dependencies**: Include dependencies where step order matters (e.g., must search before reading results)
7. **2-10 Steps**: Break complex goals into 2-10 logical task-level steps
8. **Honest Assessment**: If a goal cannot be fully achieved through desktop interactions, explain why in capabilityAssessment and set confidence appropriately low
9. **Browser Preference**: For web tasks, prefer well-known websites (Google, official sites) over obscure ones

## Example Good Plan
Goal: "Search for flights from NYC to Paris and find the cheapest option"

Good plan:
1. "Navigate to Google Flights in the browser" (NOT: "Click address bar, type URL, press Enter")
2. "Search for flights from NYC to Paris for next week" (NOT: "Click origin field, type NYC, click destination...")
3. "Sort results by price to find cheapest option" (NOT: "Click sort dropdown, click Price option")
4. "Record the cheapest flight details" (NOT: "Move cursor to price, screenshot")

Generate the plan:`;

  // Phase 11: Use gpt-oss-120b (in-house model) as primary
  const modelName = PLANNING_MODEL;

  try {
    // Phase 11: Use circuit breaker with LLM configuration
    const response = await resilientRequest<{
      choices: Array<{ message: { content: string } }>;
    }>(
      {
        method: 'POST',
        url: `${LLM_PROXY_URL}/v1/chat/completions`,
        data: {
          model: modelName,
          messages: [{ role: 'user', content: planningPrompt }],
          response_format: { type: 'json_object' },
          max_tokens: 4096,
        },
        timeout: PLANNING_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
          'X-Tenant-Id': input.tenantId,
        },
      },
      LLM_CIRCUIT_BREAKER_CONFIG,
      // Phase 11: Fallback to external model if circuit is open
      async () => {
        console.warn(`[Planning] Circuit open for ${modelName}, falling back to ${FALLBACK_MODEL}`);

        context.heartbeat({
          phase: 'fallback_planning',
          goalRunId: input.goalRunId,
          status: 'circuit_open_fallback',
          primaryModel: modelName,
          fallbackModel: FALLBACK_MODEL,
          timestamp: new Date().toISOString(),
        });

        const fallbackResponse = await resilientRequest<{
          choices: Array<{ message: { content: string } }>;
        }>(
          {
            method: 'POST',
            url: `${LLM_PROXY_URL}/v1/chat/completions`,
            data: {
              model: FALLBACK_MODEL,
              messages: [{ role: 'user', content: planningPrompt }],
              response_format: { type: 'json_object' },
              max_tokens: 4096,
            },
            timeout: PLANNING_TIMEOUT_MS,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LLM_API_KEY}`,
              'X-Tenant-Id': input.tenantId,
            },
          },
          { ...LLM_CIRCUIT_BREAKER_CONFIG, name: 'llm_proxy_fallback' }
        );

        metricsService?.recordLLMCall(FALLBACK_MODEL, 'success');
        return fallbackResponse.data;
      }
    );

    clearInterval(heartbeatInterval);

    // Record successful LLM call metrics
    const durationMs = Date.now() - startTime;
    metricsService?.recordLLMCall(modelName, 'success');
    metricsService?.recordLLMLatency(modelName, durationMs);
    metricsService?.recordActivityExecution('fallback_planning', 'success');
    metricsService?.recordActivityDuration('fallback_planning', durationMs);

    context.heartbeat({
      phase: 'fallback_planning',
      goalRunId: input.goalRunId,
      status: 'completed',
      model: modelName,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    // Parse OpenAI-compatible response format
    const content = response.data.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content);

    const steps: Step[] = (parsed.steps || []).map(
      (step: Partial<Step>, index: number) => ({
        stepNumber: step.stepNumber ?? index + 1,
        description: step.description ?? '',
        expectedOutcome: step.expectedOutcome,
        isHighRisk: step.isHighRisk ?? false,
        dependencies: step.dependencies ?? [],
      })
    );

    // Phase 13.3: Log capability assessment for monitoring
    if (parsed.capabilityAssessment) {
      console.info(`[Planning] Capability assessment: ${parsed.capabilityAssessment}`);
    }
    if (parsed.confidence !== undefined && parsed.confidence < 0.5) {
      console.warn(`[Planning] Low confidence plan (${parsed.confidence}): ${parsed.capabilityAssessment || 'No assessment provided'}`);
    }

    return {
      kind: 'PLAN',
      steps,
      planSummary: parsed.planSummary ?? 'Generated plan',
      confidence: parsed.confidence,
      capabilityAssessment: parsed.capabilityAssessment,
    };
  } catch (error) {
    clearInterval(heartbeatInterval);

    // Record failed LLM call metrics
    const durationMs = Date.now() - startTime;
    const isTimeout = error instanceof Error &&
      (error.message.includes('timeout') || error.message.includes('ETIMEDOUT'));

    metricsService?.recordLLMCall(modelName, isTimeout ? 'timeout' : 'error');
    metricsService?.recordLLMLatency(modelName, durationMs);
    metricsService?.recordActivityExecution('fallback_planning', isTimeout ? 'timeout' : 'failure');
    metricsService?.recordError('LLM_PLANNING_FAILED', true);

    throw new Error(
      `Fallback planning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
