/**
 * Internal Controller - Phase 14.3
 *
 * Provides internal API endpoints for service-to-service communication.
 * These endpoints are intended for use by Temporal workers and other internal services.
 *
 * Security: Protected by X-Internal-Request header validation.
 *
 * Endpoints:
 * - POST /api/v1/internal/plan - Generate a step-by-step plan for a goal (Phase 14.2)
 * - POST /api/v1/internal/dispatch-step - Dispatch a step for execution via TaskDispatchService
 * - POST /api/v1/internal/verify - Verify step execution result
 * - GET  /api/v1/internal/task-status/:taskId - Get task status
 *
 * Phase 14.2: Added /plan endpoint to enable proper task-level planning
 * - Fixes overly granular planning issue (mouse-level vs task-level steps)
 * - Uses industry-standard planning prompt with proper granularity guidance
 * - Follows Manus AI, ReAct, and Anthropic computer-use best practices
 *
 * Phase 14.3: Fixed LLM integration to use LiteLLM proxy
 * - Uses LLM_API_URL, LLM_API_KEY, LLM_MODEL env vars (same pattern as planner.service.ts)
 * - Routes to gpt-oss-120b via LiteLLM proxy in AIML cluster
 * - Removed broken LLMProviderService dependency
 *
 * @see /docs/TEMPORAL_INTEGRATION.md
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { IsString, IsOptional, IsBoolean, IsArray, IsNumber, ValidateNested, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskDispatchService } from '../services/task-dispatch.service';
import { PrismaService } from '../services/prisma.service';
import { GoalIntakeService } from '../services/goal-intake.service';
import { detectPlannerFirstStepUserInputReason, PlannerFirstStepUserInputError } from '../services/planner.errors';
import { ExecutionSurface, StepType } from '@prisma/client';
import { normalizeSuggestedToolsOrThrow, PlannerOutputContractViolationError } from '../contracts/planner-tools';

// ============================================================================
// DTOs
// ============================================================================

/**
 * Context for step execution
 */
class StepContextDto {
  @IsOptional()
  @IsString()
  previousStepOutcome?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  accumulatedKnowledge?: string[];
}

/**
 * Step definition for dispatch
 */
class StepDto {
  @IsNumber()
  stepNumber!: number;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  expectedOutcome?: string;

  @IsOptional()
  @IsBoolean()
  isHighRisk?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependencies?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  suggestedTools?: string[];

  @IsOptional()
  @IsBoolean()
  requiresDesktop?: boolean;

  // PR5: Explicit execution surface (TEXT_ONLY vs DESKTOP)
  @IsOptional()
  @IsEnum(ExecutionSurface)
  executionSurface?: ExecutionSurface;
}

/**
 * Request body for step dispatch
 */
class DispatchStepDto {
  @IsString()
  goalRunId!: string;

  @IsString()
  tenantId!: string;

  @ValidateNested()
  @Type(() => StepDto)
  step!: StepDto;

  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => StepContextDto)
  context?: StepContextDto;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/**
 * Response from step dispatch
 */
interface DispatchStepResponse {
  success: boolean;
  taskId?: string;
  status?: 'PENDING' | 'DISPATCHED';
  error?: string;
}

/**
 * Request body for step verification
 */
class VerifyStepDto {
  @IsString()
  goalRunId!: string;

  @IsString()
  tenantId!: string;

  @ValidateNested()
  @Type(() => StepDto)
  step!: StepDto;

  @IsString()
  expectedOutcome!: string;

  @IsOptional()
  @IsString()
  actualOutcome?: string;

  @IsBoolean()
  success!: boolean;

  @IsOptional()
  @IsString()
  error?: string;
}

/**
 * Response from step verification
 */
interface VerifyStepResponse {
  verified: boolean;
  verificationDetails: string;
  suggestReplan: boolean;
  replanReason?: string;
}

/**
 * Phase 14.2: Request body for plan generation
 * Called by Temporal workers to generate step-by-step plans
 */
class PlanRequestDto {
  @IsString()
  goalRunId!: string;

  @IsString()
  tenantId!: string;

  @IsString()
  goalDescription!: string;

  @IsOptional()
  @IsString()
  context?: string;

  @IsOptional()
  constraints?: {
    maxSteps?: number;
    allowedTools?: string[];
    workspaceMode?: string;
    riskPolicy?: {
      requireApproval?: string[];
    };
  };

  @IsOptional()
  @IsString()
  preferredModel?: string;
}

/**
 * Phase 14.2: Response from plan generation
 */
interface PlanResponse {
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

interface GoalIntakeRequiredResponse {
  kind: 'GOAL_INTAKE_REQUIRED';
  goalSpecId: string;
  promptId: string;
  reason: string;
}

type InternalPlanResponse = PlanResponse | GoalIntakeRequiredResponse;

// ============================================================================
// Controller
// ============================================================================

@Controller('internal')
@SkipThrottle() // Internal endpoints don't need rate limiting
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  // Phase 14.3: Direct LiteLLM proxy configuration (same pattern as planner.service.ts)
  private readonly llmApiUrl: string;
  private readonly llmApiKey: string;
  private readonly llmModel: string;

  constructor(
    private readonly taskDispatchService: TaskDispatchService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly goalIntakeService: GoalIntakeService,
  ) {
    // Read LLM config from environment (set in K8s deployment)
    // LLM_API_URL → http://litellm.llm.svc.cluster.local:4000/v1/messages
    // LLM_API_KEY → sk-butler-vantage (LiteLLM proxy key)
    // LLM_MODEL → openai/gpt-oss-120b
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');

    this.logger.log({
      message: 'InternalController initialized with LLM config',
      llmApiUrl: this.llmApiUrl,
      llmModel: this.llmModel,
      hasApiKey: !!this.llmApiKey,
    });
  }

  /**
   * Validate internal request header
   */
  private validateInternalRequest(internalHeader?: string): void {
    if (internalHeader !== 'true') {
      throw new HttpException('Forbidden: Internal access only', HttpStatus.FORBIDDEN);
    }
  }

  /**
   * Dispatch a step for execution
   *
   * This endpoint is called by Temporal workers to dispatch steps to ByteBot agents.
   * It uses the orchestrator's TaskDispatchService which manages:
   * - Idempotent task creation
   * - Task routing to bytebot-agent:9991
   * - Status tracking and polling
   *
   * @param body Step dispatch request
   * @param internalHeader X-Internal-Request header for authentication
   * @returns Dispatch result with taskId
   */
  @Post('dispatch-step')
  @HttpCode(HttpStatus.OK)
  async dispatchStep(
    @Body() body: DispatchStepDto,
    @Headers('x-internal-request') internalHeader?: string,
  ): Promise<DispatchStepResponse> {
    this.validateInternalRequest(internalHeader);

    this.logger.log({
      message: 'Dispatching step via internal API',
      goalRunId: body.goalRunId,
      stepNumber: body.step.stepNumber,
      tenantId: body.tenantId,
    });

    try {
      // Resolve execution surface deterministically (structured signals only; no NL heuristics).
      // Temporal worker v1 StepDto may omit surface fields; use workspace presence as the safest default.
      const resolvedExecutionSurface =
        body.step.executionSurface ??
        (typeof body.step.requiresDesktop === 'boolean'
          ? body.step.requiresDesktop
            ? ExecutionSurface.DESKTOP
            : ExecutionSurface.TEXT_ONLY
          : body.workspaceId
            ? ExecutionSurface.DESKTOP
            : ExecutionSurface.TEXT_ONLY);

      const resolvedRequiresDesktop =
        typeof body.step.requiresDesktop === 'boolean'
          ? body.step.requiresDesktop
          : resolvedExecutionSurface === ExecutionSurface.DESKTOP;

      const normalizedSuggestedTools = normalizeSuggestedToolsOrThrow({
        suggestedTools: body.step.suggestedTools,
        allowedTools: null,
      });

      // Get goal context for richer agent context
      const goalRun = await this.prisma.goalRun.findUnique({
        where: { id: body.goalRunId },
        select: { goal: true },
      });

      // Build previous step results from context
      const previousStepResults = body.context?.accumulatedKnowledge?.length
        ? body.context.accumulatedKnowledge.join('\n')
        : body.context?.previousStepOutcome;

      // Dispatch via TaskDispatchService
      const result = await this.taskDispatchService.dispatchTask({
        goalRunId: body.goalRunId,
        // Use idempotencyKey as checklistItemId for tracking
        // Format: goalRunId-step-stepNumber for Temporal compatibility
        checklistItemId: body.idempotencyKey || `${body.goalRunId}-step-${body.step.stepNumber}`,
        workspaceId: body.workspaceId,
        title: body.step.description.slice(0, 100),
        description: body.step.description,
        expectedOutcome: body.step.expectedOutcome,
        allowedTools: normalizedSuggestedTools,
        requiresDesktop: resolvedRequiresDesktop,
        executionSurface: resolvedExecutionSurface,
        // Context for autonomous operation
        goalContext: goalRun?.goal,
        previousStepResults,
        // Track retry attempts
        attempt: 1,
      });

      if (result.success && result.taskId) {
        this.logger.log({
          message: 'Step dispatched successfully',
          goalRunId: body.goalRunId,
          stepNumber: body.step.stepNumber,
          taskId: result.taskId,
        });

        return {
          success: true,
          taskId: result.taskId,
          status: 'DISPATCHED',
        };
      }

      return {
        success: false,
        error: result.error || 'Failed to dispatch step',
      };
    } catch (error: any) {
      this.logger.error({
        message: 'Failed to dispatch step',
        goalRunId: body.goalRunId,
        stepNumber: body.step.stepNumber,
        error: error.message,
      });

      return {
        success: false,
        error: error.message || 'Internal error during dispatch',
      };
    }
  }

  /**
   * Get task status by ID
   *
   * Called by Temporal workers to poll for task completion.
   *
   * @param taskId Task ID to check
   * @param internalHeader X-Internal-Request header for authentication
   * @returns Task status information
   */
  @Get('task-status/:taskId')
  @HttpCode(HttpStatus.OK)
  async getTaskStatus(
    @Param('taskId') taskId: string,
    @Headers('x-internal-request') internalHeader?: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_USER_INPUT';
    output?: {
      summary?: string;
      result?: string;
      artifacts?: string[];
    };
    error?: string;
  }> {
    this.validateInternalRequest(internalHeader);

    try {
      // Query agent API for task status
      const task = await this.taskDispatchService.getTaskStatus(taskId);

      if (!task) {
        throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
      }

      // Map agent task status to our format
      const statusMap: Record<string, 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'WAITING_USER_INPUT'> = {
        'PENDING': 'PENDING',
        'RUNNING': 'RUNNING',
        'COMPLETED': 'COMPLETED',
        'FAILED': 'FAILED',
        'CANCELLED': 'FAILED',
        'NEEDS_HELP': 'WAITING_USER_INPUT',
        'NEEDS_REVIEW': 'WAITING_USER_INPUT',
      };

      return {
        status: statusMap[task.status] || 'RUNNING',
        output: task.result ? {
          summary: task.result.summary,
          result: JSON.stringify(task.result),
          artifacts: task.result.artifacts,
        } : undefined,
        error: task.error,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;

      this.logger.error({
        message: 'Failed to get task status',
        taskId,
        error: error.message,
      });

      throw new HttpException(
        error.message || 'Failed to get task status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Verify step execution result
   *
   * Uses LLM to compare expected vs actual outcome and determine
   * if replanning is needed.
   *
   * @param body Verification request
   * @param internalHeader X-Internal-Request header for authentication
   * @returns Verification result
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyStep(
    @Body() body: VerifyStepDto,
    @Headers('x-internal-request') internalHeader?: string,
  ): Promise<VerifyStepResponse> {
    this.validateInternalRequest(internalHeader);

    this.logger.log({
      message: 'Verifying step execution',
      goalRunId: body.goalRunId,
      stepNumber: body.step.stepNumber,
      success: body.success,
    });

    // If step failed, suggest replan
    if (!body.success) {
      return {
        verified: false,
        verificationDetails: `Step failed with error: ${body.error || 'Unknown error'}`,
        suggestReplan: true,
        replanReason: body.error || 'Step execution failed',
      };
    }

    // If no expected outcome, auto-verify based on success
    if (!body.expectedOutcome) {
      return {
        verified: true,
        verificationDetails: 'Step completed successfully (no expected outcome to verify)',
        suggestReplan: false,
      };
    }

    try {
      // Use LLM to verify outcome matches expectation
      const verificationPrompt = `You are verifying if a step execution achieved its expected outcome.

Expected Outcome:
${body.expectedOutcome}

Actual Outcome:
${body.actualOutcome || 'No outcome provided'}

Step Description:
${body.step.description}

Respond in JSON format:
{
  "verified": true/false,
  "confidence": 0-100,
  "explanation": "Brief explanation",
  "suggestReplan": true/false,
  "replanReason": "If replan needed, explain why"
}`;

      // Phase 14.3: Call LLM directly via LiteLLM proxy
      const responseText = await this.callLLM(verificationPrompt, 500, 0.1);

      // Parse JSON response
      try {
        const parsed = JSON.parse(responseText);
        return {
          verified: Boolean(parsed.verified),
          verificationDetails: parsed.explanation || 'Verification completed',
          suggestReplan: Boolean(parsed.suggestReplan),
          replanReason: parsed.replanReason,
        };
      } catch {
        // Fallback if LLM response isn't valid JSON
        return {
          verified: true,
          verificationDetails: 'Verification completed (LLM response parsing fallback)',
          suggestReplan: false,
        };
      }
    } catch (error: any) {
      this.logger.warn({
        message: 'LLM verification failed, using fallback',
        error: error.message,
      });

      // Fallback: simple verification based on success flag
      return {
        verified: body.success,
        verificationDetails: `Fallback verification: ${body.success ? 'success' : 'failed'}`,
        suggestReplan: !body.success,
        replanReason: body.error,
      };
    }
  }

  /**
   * Health check for internal services
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  async health(): Promise<{ status: string; timestamp: string }> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Phase 14.2: Generate a step-by-step plan for a goal
   *
   * This endpoint is called by Temporal workers to generate plans.
   * It uses an industry-standard planning prompt that:
   * - Generates task-level steps (not mouse/keyboard-level)
   * - Follows Manus AI, ReAct, and Anthropic computer-use best practices
   * - Prevents overly granular step generation
   *
   * Key Design Decisions:
   * - Steps are "logical tasks" not "atomic actions"
   * - Each step should accomplish a meaningful sub-goal
   * - Steps are verifiable through visual observation of outcomes
   *
   * @param body Plan request with goal description and constraints
   * @param internalHeader X-Internal-Request header for authentication
   * @returns Generated plan with steps
   */
  @Post('plan')
  @HttpCode(HttpStatus.OK)
  async generatePlan(
    @Body() body: PlanRequestDto,
    @Headers('x-internal-request') internalHeader?: string,
  ): Promise<InternalPlanResponse> {
    this.validateInternalRequest(internalHeader);

    this.logger.log({
      message: 'Generating plan via internal API',
      goalRunId: body.goalRunId,
      tenantId: body.tenantId,
      goalDescription: body.goalDescription.substring(0, 100),
    });

    const startTime = Date.now();

    try {
      // Stark rule: do not plan until GoalSpec is COMPLETE.
      const intakeGate = await this.goalIntakeService.ensureGoalSpecReadyForPlanning({
        goalRunId: body.goalRunId,
        tenantId: body.tenantId,
      });

      if (!intakeGate.ready) {
        this.logger.warn({
          message: 'Goal intake required before planning (GoalSpec gate)',
          goalRunId: body.goalRunId,
          goalSpecId: intakeGate.goalSpecId,
          promptId: intakeGate.promptId,
        });

        return {
          kind: 'GOAL_INTAKE_REQUIRED',
          goalSpecId: intakeGate.goalSpecId,
          promptId: intakeGate.promptId,
          reason: 'GOAL_SPEC_INCOMPLETE',
        };
      }

      const basePrompt = this.buildPlanningPrompt(body);
      const maxContractAttempts = 3;

      let lastContractError: PlannerOutputContractViolationError | null = null;
      let parsed: any = null;
      let steps: Array<{
        stepNumber: number;
        description: string;
        expectedOutcome?: string;
        isHighRisk: boolean;
        dependencies: any[];
        estimatedDurationMs?: number;
      }> = [];

      for (let attempt = 1; attempt <= maxContractAttempts; attempt++) {
        const planningPrompt =
          attempt === 1
            ? basePrompt
            : `${basePrompt}\n\nCORRECTION REQUIRED:\n` +
              `- Your previous JSON violated the planner-output contract.\n` +
              `- suggestedTools MUST be either [] or a subset of the Allowed tools list. Never invent tool tokens.\n` +
              `- If a step requires user input, use type=USER_INPUT_REQUIRED and suggestedTools=[\"ASK_USER\"] (never \"CHAT\").\n`;

        // Phase 14.3: Call LLM directly via LiteLLM proxy
        // Routes to gpt-oss-120b (120B parameter model) for high-quality planning
        const responseText = await this.callLLM(planningPrompt, 4096, 0.3);

        // Parse JSON response
        let candidateParsed: any;
        try {
          // Extract JSON from potential markdown code blocks
          const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
          const jsonStr = jsonMatch ? jsonMatch[1] : responseText;
          candidateParsed = JSON.parse(jsonStr.trim());
        } catch {
          // Try to find JSON object in response
          const objectMatch = responseText.match(/\{[\s\S]*\}/);
          if (objectMatch) {
            candidateParsed = JSON.parse(objectMatch[0]);
          } else {
            throw new Error('Failed to parse LLM response as JSON');
          }
        }

        const rawSteps = Array.isArray(candidateParsed.steps) ? candidateParsed.steps : [];

        try {
          // Build a normalized representation so we can apply contract gates deterministically.
          // We do not accept plans that contain interaction-shaped steps; those must be handled via Goal Intake.
          type NormalizedPlannerChecklistItem = {
            description: string;
            type: StepType;
            expectedOutcome?: string;
            suggestedTools: string[];
            requiresDesktop: boolean;
            stepNumber: number;
            isHighRisk: boolean;
            dependencies: any[];
            estimatedDurationMs?: number;
          };

          const normalizedChecklist: NormalizedPlannerChecklistItem[] = rawSteps.map((rawStep: any, index: number) => ({
            description: typeof rawStep?.description === 'string' ? rawStep.description : '',
            type: rawStep?.type === StepType.USER_INPUT_REQUIRED ? StepType.USER_INPUT_REQUIRED : StepType.EXECUTE,
            expectedOutcome: typeof rawStep?.expectedOutcome === 'string' ? rawStep.expectedOutcome : undefined,
            suggestedTools: normalizeSuggestedToolsOrThrow({
              suggestedTools: Array.isArray(rawStep?.suggestedTools) ? rawStep.suggestedTools : [],
              allowedTools: body.constraints?.allowedTools,
            }),
            requiresDesktop: typeof rawStep?.requiresDesktop === 'boolean' ? rawStep.requiresDesktop : false,
            stepNumber: rawStep?.stepNumber ?? index + 1,
            isHighRisk: rawStep?.isHighRisk ?? false,
            dependencies: rawStep?.dependencies ?? [],
            estimatedDurationMs: rawStep?.estimatedDurationMs,
          }));

          const firstInteraction = normalizedChecklist.find((item: NormalizedPlannerChecklistItem) =>
            detectPlannerFirstStepUserInputReason(item),
          );
          if (firstInteraction) {
            const reason = detectPlannerFirstStepUserInputReason(firstInteraction) ?? 'ASK_USER_TOOL';
            const error = new PlannerFirstStepUserInputError({
              mode: 'initial',
              firstStep: firstInteraction,
              reason,
            });

            const intake = await this.goalIntakeService.requestGoalIntakeFromPlannerError({
              goalRunId: body.goalRunId,
              tenantId: body.tenantId,
              error,
            });

            this.logger.warn({
              message: 'Planner produced an interaction-shaped step; issuing Goal Intake prompt instead',
              goalRunId: body.goalRunId,
              goalSpecId: intake.goalSpecId,
              promptId: intake.promptId,
              reason: error.reason,
            });

            return {
              kind: 'GOAL_INTAKE_REQUIRED',
              goalSpecId: intake.goalSpecId,
              promptId: intake.promptId,
              reason: error.reason,
            };
          }

          steps = normalizedChecklist.map((item: NormalizedPlannerChecklistItem) => ({
            stepNumber: item.stepNumber,
            description: item.description,
            expectedOutcome: item.expectedOutcome,
            isHighRisk: item.isHighRisk ?? false,
            dependencies: item.dependencies ?? [],
            estimatedDurationMs: item.estimatedDurationMs,
          }));

          parsed = candidateParsed;
          break;
        } catch (error: any) {
          if (error instanceof PlannerOutputContractViolationError) {
            lastContractError = error;
            this.logger.warn({
              message: 'Planner output contract violation (retrying)',
              goalRunId: body.goalRunId,
              attempt,
              code: error.code,
            });
            continue;
          }
          throw error;
        }
      }

      if (!parsed) {
        if (lastContractError) throw lastContractError;
        throw new Error('Failed to generate plan');
      }

      const durationMs = Date.now() - startTime;
      this.logger.log({
        message: 'Plan generated successfully',
        goalRunId: body.goalRunId,
        stepCount: steps.length,
        durationMs,
        confidence: parsed.confidence,
      });

      return {
        kind: 'PLAN',
        steps,
        planSummary: parsed.planSummary || parsed.summary || 'Generated plan',
        estimatedDurationMs: parsed.estimatedDurationMs,
        confidence: parsed.confidence,
      };
    } catch (error: any) {
      this.logger.error({
        message: 'Failed to generate plan',
        goalRunId: body.goalRunId,
        error: error.message,
      });

      // Return a sensible fallback plan
      return this.generateFallbackPlan(body.goalDescription);
    }
  }

  /**
   * Phase 14.2: Build planning prompt with proper granularity guidance
   *
   * Key improvements over previous prompts:
   * 1. Explicit "task-level" vs "action-level" distinction
   * 2. Examples of good vs bad step granularity
   * 3. Clear instruction that steps are NOT individual mouse/keyboard actions
   * 4. Manus AI-style: steps should be "meaningful sub-goals"
   */
  private buildPlanningPrompt(body: PlanRequestDto): string {
    const maxSteps = body.constraints?.maxSteps || 10;
    const allowedTools = body.constraints?.allowedTools?.join(', ') || 'any desktop tools';
    const workspaceMode = body.constraints?.workspaceMode || 'SHARED';

    return `You are Butler Vantage, a DESKTOP-BASED autonomous agent that plans and executes tasks by controlling a virtual desktop environment.

## Your Environment
You operate within a virtual desktop and interact with applications through:
- Mouse control (click, drag, scroll)
- Keyboard input (type, shortcuts)
- Visual observation (screenshots)
- Application interaction (browsers, editors, etc.)

## CRITICAL: Step Granularity Guidelines

Steps should be **TASK-LEVEL**, not **ACTION-LEVEL**.

### BAD Examples (Too Granular - DO NOT DO THIS):
- "Move cursor to address bar"
- "Click on the address bar"
- "Type 'https://www.google.com'"
- "Press Enter key"

### GOOD Examples (Correct Granularity):
- "Navigate to google.com in the browser"
- "Search for 'cheap flights to Paris' on Google"
- "Fill out the login form with provided credentials"
- "Download the PDF report from the dashboard"

### The Difference:
- **Task-level step**: Accomplishes a meaningful sub-goal (e.g., "Navigate to website")
- **Action-level step**: A single mouse/keyboard action (e.g., "Click", "Type", "Press Enter")

Your steps should be task-level. The execution engine handles the individual actions.

## Goal to Plan
${body.goalDescription}

${body.context ? `## Additional Context\n${body.context}\n` : ''}
## Constraints
- Maximum steps: ${maxSteps}
- Allowed tools: ${allowedTools}
- Workspace mode: ${workspaceMode}
${body.constraints?.riskPolicy?.requireApproval?.length ? `- Actions requiring approval: ${body.constraints.riskPolicy.requireApproval.join(', ')}` : ''}

## Output Format (JSON)
{
  "planSummary": "Brief description of the overall approach",
  "steps": [
    {
      "stepNumber": 1,
      "description": "Clear task-level description (NOT individual mouse/keyboard actions)",
      "type": "EXECUTE | USER_INPUT_REQUIRED",
      "suggestedTools": [],
      "requiresDesktop": true,
      "expectedOutcome": "What should be observable when this step succeeds",
      "isHighRisk": false,
      "dependencies": [],
      "estimatedDurationMs": 30000
    }
  ],
  "confidence": 0.85,
  "estimatedDurationMs": 120000
}

## Planning Rules
1. **Task-Level Steps**: Each step should accomplish a meaningful sub-goal, not a single UI action
2. **2-${maxSteps} Steps**: Break complex goals into 2-${maxSteps} logical steps
3. **Verifiable Outcomes**: Each step should have an observable outcome (not "cursor moved")
4. **Dependencies**: Mark dependencies where step order matters
5. **High-Risk Marking**: Mark steps that submit data, make purchases, or modify external systems as isHighRisk: true
6. **Desktop-Achievable**: Every step must be achievable through desktop interactions (no API calls)
7. **Specific but Not Granular**: Be specific about what to do, but don't specify individual clicks/keystrokes
8. **Tool Vocabulary (Fail-Closed)**: suggestedTools MUST be [] or a subset of the Allowed tools list. Never invent tool tokens.
9. **User Interaction Tooling**: If a step requires user input, set type=USER_INPUT_REQUIRED and suggestedTools=["ASK_USER"] (never "CHAT").
10. **No Prompt-First Plans**: The FIRST step MUST NOT require user input. If you need clarification to start, assume safe defaults and begin with an EXECUTE step.

## Example Good Plan
Goal: "Search for flights from NYC to Paris and find the cheapest option"

Good plan:
1. "Open Google Flights in the browser" (NOT: "Click address bar, type URL, press Enter")
2. "Search for flights from NYC to Paris for next week" (NOT: "Click origin field, type NYC, click destination...")
3. "Sort results by price to find cheapest option" (NOT: "Click sort dropdown, click Price option")
4. "Record the cheapest flight details" (NOT: "Move cursor to price, screenshot")

Generate the plan:`;
  }

  /**
   * Generate a fallback plan when LLM fails
   */
  private generateFallbackPlan(goal: string): PlanResponse {
    return {
      kind: 'PLAN',
      steps: [
        {
          stepNumber: 1,
          description: `Analyze the goal and identify the target application or website`,
          expectedOutcome: 'Clear understanding of where to perform the task',
          isHighRisk: false,
          dependencies: [],
          estimatedDurationMs: 15000,
        },
        {
          stepNumber: 2,
          description: `Execute the main task: ${goal.substring(0, 100)}`,
          expectedOutcome: 'Task objective achieved',
          isHighRisk: false,
          dependencies: [1],
          estimatedDurationMs: 60000,
        },
        {
          stepNumber: 3,
          description: 'Verify the task was completed successfully',
          expectedOutcome: 'Visual confirmation of success',
          isHighRisk: false,
          dependencies: [2],
          estimatedDurationMs: 15000,
        },
      ],
      planSummary: `Execute goal: ${goal.substring(0, 100)}`,
      estimatedDurationMs: 90000,
      confidence: 0.5,
    };
  }

  /**
   * Phase 14.3: Call LLM via LiteLLM proxy
   *
   * Uses the same pattern as planner.service.ts for consistency.
   * Routes to gpt-oss-120b (120B parameter model) via LiteLLM proxy.
   *
   * @param prompt The prompt to send to the LLM
   * @param maxTokens Maximum tokens in response (default 2000)
   * @param temperature Temperature for response generation (default 0.7)
   * @returns The LLM response text
   */
  private async callLLM(prompt: string, maxTokens = 2000, temperature = 0.7): Promise<string> {
    // If no API key configured, log warning and throw
    if (!this.llmApiKey) {
      this.logger.error({
        message: 'No LLM API key configured',
        llmApiUrl: this.llmApiUrl,
        llmModel: this.llmModel,
      });
      throw new Error('LLM API key not configured');
    }

    this.logger.debug({
      message: 'Calling LLM via LiteLLM proxy',
      llmApiUrl: this.llmApiUrl,
      llmModel: this.llmModel,
      maxTokens,
      temperature,
      promptLength: prompt.length,
    });

    const startTime = Date.now();

    try {
      const response = await fetch(this.llmApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.llmApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.llmModel,
          max_tokens: maxTokens,
          temperature,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error({
          message: 'LLM API error',
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          llmApiUrl: this.llmApiUrl,
          llmModel: this.llmModel,
        });
        throw new Error(`LLM API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      const durationMs = Date.now() - startTime;

      this.logger.log({
        message: 'LLM call successful',
        llmModel: this.llmModel,
        durationMs,
        responseLength: data.content?.[0]?.text?.length || 0,
      });

      return data.content[0].text;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      this.logger.error({
        message: 'LLM call failed',
        error: error.message,
        llmApiUrl: this.llmApiUrl,
        llmModel: this.llmModel,
        durationMs,
      });
      throw error;
    }
  }
}
