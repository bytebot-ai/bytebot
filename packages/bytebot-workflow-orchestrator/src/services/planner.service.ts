/**
 * Planner Service
 * v2.0.0: Context-Preserving Replanning (Industry Standard Fix)
 *   - Include actualOutcome in replan prompts so LLM knows what was accomplished
 *   - Preserve completed steps during replanning (don't re-do work)
 *   - Add explicit "COMPLETED WORK - DO NOT REDO" section in prompts
 *   - Manus-style: External state representation via checkpoint
 *   - LangGraph-style: Don't re-run successful nodes on recovery
 * v1.0.1: Added defensive check in createPlanVersion to prevent duplicate version errors
 * v1.0.0: LLM-powered plan generation for Manus-style orchestration
 *
 * Responsibilities:
 * - Generate initial plans from natural language goals
 * - Generate replans when execution fails
 * - Validate plan structure and feasibility
 * - Estimate goal complexity
 * - Preserve context across replanning (v2.0.0)
 *
 * Race Condition Safeguard (v1.0.1):
 * - createPlanVersion: Checks if version already exists before creating
 * - Returns existing plan version if found (defensive programming)
 *
 * Context Preservation (v2.0.0):
 * - buildReplanningPrompt: Now includes actualOutcome for COMPLETED steps
 * - generateReplan: Option to preserve completed items in new plan version
 * - Follows industry best practices from Manus AI, LangGraph, OpenAI Assistants
 *
 * @see /documentation/2026-01-03-CONTEXT_PRESERVING_REPLAN_FIX.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { GoalRunService } from './goal-run.service';
import { createId } from '@paralleldrive/cuid2';
import {
  ChecklistItemStatus,
  ExecutionSurface,
  GoalRunPhase,
  GoalSpecStatus,
  StepType,
  UserPromptKind,
  UserPromptStatus,
} from '@prisma/client';
import { z } from 'zod';
import { detectPlannerFirstStepUserInputReason, PlannerFirstStepUserInputError } from './planner.errors';
import {
  ExecuteStepHasInteractionToolError,
  PlannerOutputContractViolationError,
  hasUserInteractionTool,
  normalizeSuggestedToolsOrThrow,
} from '../contracts/planner-tools';

// Zod schema for LLM plan output validation
const ChecklistItemSchema = z.object({
  description: z.string().min(5).max(500),
  type: z.nativeEnum(StepType),
  expectedOutcome: z.string().optional(),
  suggestedTools: z.array(z.string()).optional(),
  requiresDesktop: z.boolean().optional(),
  isPreservedFromPrevious: z.boolean().optional(), // v2.0.0: Marks items preserved from previous plan
});

const PlanOutputSchema = z.object({
  summary: z.string().max(500),
  items: z.array(ChecklistItemSchema).min(1).max(20),
  confidence: z.number().min(0).max(1).optional(),
  preserveCompletedSteps: z.boolean().optional(), // v2.0.0: Indicates LLM respects completed work
});

type PlanOutput = z.infer<typeof PlanOutputSchema>;

// v2.0.0: Interface for preserved checklist item from previous plan
interface PreservedChecklistItem {
  id: string;
  order: number;
  description: string;
  status: string;
  actualOutcome: string | null;
  expectedOutcome: string | null;
  suggestedTools: string[];
  requiresDesktop: boolean;
  type: StepType;
  executionSurface: ExecutionSurface;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface PlanGenerationResult {
  planVersionId: string;
  version: number;
  summary: string;
  items: {
    id: string;
    order: number;
    description: string;
    expectedOutcome?: string;
    suggestedTools: string[];
    requiresDesktop: boolean;
  }[];
  confidence?: number;
  tokensUsed?: number;
}

export interface ComplexityEstimate {
  level: 'simple' | 'moderate' | 'complex';
  estimatedSteps: number;
  requiresDesktop: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  warnings: string[];
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
  private readonly llmModel: string;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;

  constructor(
    private prisma: PrismaService,
    private goalRunService: GoalRunService,
    private configService: ConfigService,
  ) {
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
  }

  /**
   * Generate initial plan from goal
   */
  async generateInitialPlan(goalRunId: string): Promise<PlanGenerationResult> {
    this.logger.log(`Generating initial plan for goal run ${goalRunId}`);

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: goalRunId },
    });

    if (!goalRun) {
      throw new Error(`Goal run ${goalRunId} not found`);
    }

    const goalSpec = await this.prisma.goalSpec.findUnique({
      where: { goalRunId },
      select: { status: true, schemaId: true, schemaVersion: true, values: true },
    });

    const goalSpecContext =
      goalSpec?.status === GoalSpecStatus.COMPLETE
        ? `\n\nGOAL INTAKE (schema=${goalSpec.schemaId}@${goalSpec.schemaVersion}):\n${JSON.stringify(goalSpec.values, null, 2)}`
        : '';

    // Generate plan using LLM
    const planOutput = await this.callLLMForPlan(goalRun.goal, goalRun.constraints as any, {
      goalSpecContext,
    });

    // Create plan version
    const result = await this.createPlanVersion(goalRunId, planOutput, 1);

    // Update goal run current plan version
    await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { currentPlanVersion: 1 },
    });

    // Create activity event
    await this.goalRunService.createActivityEvent(goalRunId, {
      eventType: 'PLANNING_COMPLETED',
      title: 'Plan generated',
      description: `Generated ${result.items.length} steps`,
      planVersionId: result.planVersionId,
    });

    return result;
  }

  /**
   * Generate replan after failure
   *
   * v2.0.0: Context-Preserving Replanning
   * - Preserves completed steps from previous plan (LangGraph-style)
   * - Copies actualOutcome, timestamps, and status to new plan
   * - Only generates new steps for failed/pending items
   * - Manus-style: Keeps completed work visible and builds upon it
   */
  async generateReplan(
    goalRunId: string,
    reason: string,
    context?: {
      failedItemId?: string;
      failureDetails?: string;
    },
  ): Promise<PlanGenerationResult> {
    this.logger.log(`Generating replan for goal run ${goalRunId}: ${reason}`);

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
      throw new Error(`Goal run ${goalRunId} not found`);
    }

    const userPrompts = await this.prisma.userPrompt.findMany({
      where: { goalRunId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        checklistItemId: true,
        kind: true,
        status: true,
        payload: true,
        answers: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    const userPromptContext = this.formatUserPromptContext(userPrompts);

    // Update phase to REPLANNING
    await this.goalRunService.updatePhase(goalRunId, GoalRunPhase.REPLANNING);

    const currentPlan = goalRun.planVersions[0];
    const newVersion = (currentPlan?.version || 0) + 1;

    // v2.0.0: Extract completed items to preserve (LangGraph-style: don't re-run successful nodes)
    const completedItems: PreservedChecklistItem[] = (currentPlan?.checklistItems || [])
      .filter((item: any) => item.status === 'COMPLETED')
      .map((item: any) => ({
        id: item.id,
        order: item.order,
        description: item.description,
        status: item.status,
        actualOutcome: item.actualOutcome,
        expectedOutcome: item.expectedOutcome,
        suggestedTools: item.suggestedTools,
        requiresDesktop: item.requiresDesktop,
        type: item.type ?? StepType.EXECUTE,
        executionSurface:
          item.executionSurface ?? (item.requiresDesktop ? ExecutionSurface.DESKTOP : ExecutionSurface.TEXT_ONLY),
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      }));

    this.logger.log(
      `Preserving ${completedItems.length} completed steps from previous plan v${currentPlan?.version || 0}`,
    );

    // Generate replan using LLM with context (includes completed work)
    const planOutput = await this.callLLMForReplan(
      goalRun.goal,
      goalRun.constraints as any,
      currentPlan,
      reason,
      context,
      userPromptContext,
    );

    // v2.0.0: Create new plan version with preserved completed items
    const result = await this.createPlanVersionWithPreservedSteps(
      goalRunId,
      planOutput,
      newVersion,
      completedItems,
      currentPlan?.id,
      reason,
    );

    // Update goal run current plan version
    await this.prisma.goalRun.update({
      where: { id: goalRunId },
      data: { currentPlanVersion: newVersion },
    });

    // Create activity event with context preservation info
    await this.goalRunService.createActivityEvent(goalRunId, {
      eventType: 'REPLAN_COMPLETED',
      title: 'Plan updated (with preserved progress)',
      description: `Replan reason: ${reason}. Preserved ${completedItems.length} completed steps.`,
      planVersionId: result.planVersionId,
    });

    return result;
  }

  /**
   * Validate plan structure
   */
  async validatePlan(planOutput: unknown): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    try {
      PlanOutputSchema.parse(planOutput);
      return { valid: true, errors: [] };
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.errors.map((e: z.ZodIssue) => `${e.path.join('.')}: ${e.message}`),
        };
      }
      return { valid: false, errors: [error.message] };
    }
  }

  /**
   * Estimate goal complexity
   */
  async estimateComplexity(goal: string): Promise<ComplexityEstimate> {
    this.logger.log(`Estimating complexity for goal: "${goal.substring(0, 50)}..."`);

    // Simple heuristic-based estimation
    const lowerGoal = goal.toLowerCase();

    // Check for desktop-related keywords
    const desktopKeywords = [
      'click', 'type', 'browser', 'website', 'login', 'download',
      'upload', 'screenshot', 'navigate', 'fill', 'form', 'button',
    ];
    const requiresDesktop = desktopKeywords.some((kw) => lowerGoal.includes(kw));

    // Check for high-risk keywords
    const highRiskKeywords = [
      'email', 'send', 'delete', 'transfer', 'payment', 'purchase',
      'password', 'credentials', 'sensitive', 'confidential',
    ];
    const highRiskCount = highRiskKeywords.filter((kw) => lowerGoal.includes(kw)).length;

    // Estimate step count based on goal complexity
    const connectors = ['and', 'then', 'after', 'before', 'also', 'finally'];
    const connectorCount = connectors.filter((c) => lowerGoal.includes(` ${c} `)).length;
    const estimatedSteps = Math.max(2, Math.min(10, connectorCount + 2));

    // Determine complexity level
    let level: 'simple' | 'moderate' | 'complex';
    if (estimatedSteps <= 3 && highRiskCount === 0) {
      level = 'simple';
    } else if (estimatedSteps <= 6 || highRiskCount <= 1) {
      level = 'moderate';
    } else {
      level = 'complex';
    }

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high';
    if (highRiskCount === 0) {
      riskLevel = 'low';
    } else if (highRiskCount <= 2) {
      riskLevel = 'medium';
    } else {
      riskLevel = 'high';
    }

    // Generate warnings
    const warnings: string[] = [];
    if (highRiskCount > 0) {
      warnings.push('Goal involves potentially sensitive operations');
    }
    if (goal.length < 20) {
      warnings.push('Goal description may be too vague');
    }
    if (goal.length > 500) {
      warnings.push('Goal description is very long - consider breaking into smaller goals');
    }

    return {
      level,
      estimatedSteps,
      requiresDesktop,
      riskLevel,
      warnings,
    };
  }

  // Private methods

  /**
   * Create a new plan version with checklist items
   * v1.0.1: Added defensive check to prevent duplicate version errors (Option 3)
   */
  private async createPlanVersion(
    goalRunId: string,
    planOutput: PlanOutput,
    version: number,
    previousVersionId?: string,
    replanReason?: string,
  ): Promise<PlanGenerationResult> {
    // Defensive check: verify version doesn't already exist (Option 3 safeguard)
    // This catches any edge cases that slip through the primary fix in orchestrator-loop
    const existingVersion = await this.prisma.planVersion.findFirst({
      where: { goalRunId, version },
      include: {
        checklistItems: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (existingVersion) {
      this.logger.warn(
        `Plan version ${version} already exists for goal run ${goalRunId}, returning existing`,
      );
      return {
        planVersionId: existingVersion.id,
        version: existingVersion.version,
        summary: existingVersion.summary || '',
        items: existingVersion.checklistItems.map((item) => ({
          id: item.id,
          order: item.order,
          description: item.description,
          expectedOutcome: item.expectedOutcome || undefined,
          suggestedTools: item.suggestedTools,
          requiresDesktop: item.requiresDesktop,
        })),
        confidence: existingVersion.confidence || undefined,
      };
    }

    const planVersionId = `pv-${createId()}`;

    // Create plan version with checklist items in a transaction
    await this.prisma.$transaction(async (tx) => {
      await tx.planVersion.create({
        data: {
          id: planVersionId,
          goalRunId,
          version,
          summary: planOutput.summary,
          previousVersionId,
          replanReason,
          llmModel: this.llmModel,
          confidence: planOutput.confidence,
        },
      });

      // Create checklist items
      for (let i = 0; i < planOutput.items.length; i++) {
        const item = planOutput.items[i];
        await tx.checklistItem.create({
          data: {
            id: `ci-${createId()}`,
            planVersionId,
            order: i + 1,
            description: item.description,
            type: item.type,
            status: ChecklistItemStatus.PENDING,
            expectedOutcome: item.expectedOutcome,
            suggestedTools: item.suggestedTools || [],
            requiresDesktop: item.requiresDesktop || false,
            executionSurface: item.requiresDesktop ? ExecutionSurface.DESKTOP : ExecutionSurface.TEXT_ONLY,
          },
        });
      }
    });

    // Fetch created items
    const createdItems = await this.prisma.checklistItem.findMany({
      where: { planVersionId },
      orderBy: { order: 'asc' },
    });

    return {
      planVersionId,
      version,
      summary: planOutput.summary,
      items: createdItems.map((item) => ({
        id: item.id,
        order: item.order,
        description: item.description,
        expectedOutcome: item.expectedOutcome || undefined,
        suggestedTools: item.suggestedTools,
        requiresDesktop: item.requiresDesktop,
      })),
      confidence: planOutput.confidence || undefined,
    };
  }

  /**
   * v2.0.0: Create plan version with preserved completed steps
   *
   * This implements LangGraph-style "don't re-run successful nodes":
   * 1. Preserved completed items are added FIRST with their original data
   * 2. New items from LLM are added AFTER, starting at the next order number
   * 3. Completed items retain actualOutcome, timestamps, and COMPLETED status
   *
   * This ensures:
   * - Completed work is never lost during replanning
   * - The agent can continue from where it left off
   * - Context is preserved for dependent steps
   */
  private async createPlanVersionWithPreservedSteps(
    goalRunId: string,
    planOutput: PlanOutput,
    version: number,
    preservedItems: PreservedChecklistItem[],
    previousVersionId?: string,
    replanReason?: string,
  ): Promise<PlanGenerationResult> {
    // Defensive check: verify version doesn't already exist
    const existingVersion = await this.prisma.planVersion.findFirst({
      where: { goalRunId, version },
      include: {
        checklistItems: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (existingVersion) {
      this.logger.warn(
        `Plan version ${version} already exists for goal run ${goalRunId}, returning existing`,
      );
      return {
        planVersionId: existingVersion.id,
        version: existingVersion.version,
        summary: existingVersion.summary || '',
        items: existingVersion.checklistItems.map((item) => ({
          id: item.id,
          order: item.order,
          description: item.description,
          expectedOutcome: item.expectedOutcome || undefined,
          suggestedTools: item.suggestedTools,
          requiresDesktop: item.requiresDesktop,
        })),
        confidence: existingVersion.confidence || undefined,
      };
    }

    const planVersionId = `pv-${createId()}`;
    const preservedCount = preservedItems.length;

    this.logger.log(
      `Creating plan v${version} with ${preservedCount} preserved steps + ${planOutput.items.length} new steps`,
    );

    // Create plan version with checklist items in a transaction
    await this.prisma.$transaction(async (tx) => {
      // Create plan version with metadata about preservation
      await tx.planVersion.create({
        data: {
          id: planVersionId,
          goalRunId,
          version,
          summary: `${planOutput.summary} (preserved ${preservedCount} completed steps)`,
          previousVersionId,
          replanReason,
          llmModel: this.llmModel,
          confidence: planOutput.confidence,
        },
      });

      // Step 1: Create preserved completed items FIRST
      // These keep their COMPLETED status and actualOutcome
      for (let i = 0; i < preservedItems.length; i++) {
        const preserved = preservedItems[i];
        await tx.checklistItem.create({
          data: {
            id: `ci-${createId()}`,
            planVersionId,
            order: i + 1, // Preserved items get order 1, 2, 3...
            description: preserved.description,
            type: preserved.type,
            status: ChecklistItemStatus.COMPLETED, // Keep COMPLETED status!
            expectedOutcome: preserved.expectedOutcome,
            actualOutcome: preserved.actualOutcome, // CRITICAL: Preserve the outcome!
            suggestedTools: preserved.suggestedTools,
            requiresDesktop: preserved.requiresDesktop,
            executionSurface: preserved.executionSurface,
            startedAt: preserved.startedAt,
            completedAt: preserved.completedAt,
          },
        });
      }

      // Step 2: Create new items from LLM AFTER preserved items
      // These are PENDING and start after the preserved items
      const startOrder = preservedItems.length + 1;
      for (let i = 0; i < planOutput.items.length; i++) {
        const item = planOutput.items[i];

        // Skip items that LLM marked as "isPreservedFromPrevious" since we already added them
        if (item.isPreservedFromPrevious) {
          this.logger.debug(`Skipping LLM-preserved item (already added): ${item.description}`);
          continue;
        }

        await tx.checklistItem.create({
          data: {
            id: `ci-${createId()}`,
            planVersionId,
            order: startOrder + i,
            description: item.description,
            type: item.type,
            status: ChecklistItemStatus.PENDING,
            expectedOutcome: item.expectedOutcome,
            suggestedTools: item.suggestedTools || [],
            requiresDesktop: item.requiresDesktop || false,
            executionSurface: item.requiresDesktop ? ExecutionSurface.DESKTOP : ExecutionSurface.TEXT_ONLY,
          },
        });
      }
    });

    // Fetch created items
    const createdItems = await this.prisma.checklistItem.findMany({
      where: { planVersionId },
      orderBy: { order: 'asc' },
    });

    this.logger.log(
      `Created plan v${version}: ${createdItems.filter(i => i.status === 'COMPLETED').length} completed + ` +
      `${createdItems.filter(i => i.status === 'PENDING').length} pending`,
    );

    return {
      planVersionId,
      version,
      summary: planOutput.summary,
      items: createdItems.map((item) => ({
        id: item.id,
        order: item.order,
        description: item.description,
        expectedOutcome: item.expectedOutcome || undefined,
        suggestedTools: item.suggestedTools,
        requiresDesktop: item.requiresDesktop,
      })),
      confidence: planOutput.confidence || undefined,
    };
  }

  private async callLLMForPlan(
    goal: string,
    constraints: any,
    options?: { goalSpecContext?: string },
  ): Promise<PlanOutput> {
    const basePrompt = this.buildPlanningPrompt(goal, constraints, options?.goalSpecContext);
    const maxContractAttempts = 2;

    let lastContractError: PlannerOutputContractViolationError | null = null;

    for (let attempt = 1; attempt <= maxContractAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\n` +
            `CORRECTION REQUIRED:\n` +
            `- Your previous JSON violated the planner-output contract.\n` +
            `- suggestedTools MUST be either [] or a subset of the Allowed tools list. Do not invent tool tokens.\n` +
            `- If a step requires user clarification, set type=USER_INPUT_REQUIRED and suggestedTools=[\"ASK_USER\"] (never \"CHAT\").\n`;

      try {
        const response = await this.callLLM(prompt);
        const parsed = this.parseLLMResponse(response);

        // Validate
        const validation = await this.validatePlan(parsed);
        if (!validation.valid) {
          this.logger.warn(`Plan validation failed: ${validation.errors.join(', ')}`);
          // Return a fallback simple plan
          return this.generateFallbackPlan(goal);
        }

        return this.normalizePlanOutput(parsed as PlanOutput, {
          goal,
          mode: 'initial',
          allowedTools: constraints?.allowedTools,
        });
      } catch (error: any) {
        if (error instanceof PlannerFirstStepUserInputError) {
          throw error;
        }

        if (error instanceof PlannerOutputContractViolationError) {
          lastContractError = error;
          this.logger.warn(
            `Planner output contract violation on attempt ${attempt}/${maxContractAttempts}: ${error.code}`,
          );
          continue;
        }

        this.logger.error(`LLM call failed: ${error.message}`);
        // Return fallback plan
        return this.generateFallbackPlan(goal);
      }
    }

    // Fail-closed: do not persist a plan with drifted/unknown tool vocabulary.
    if (lastContractError) {
      throw lastContractError;
    }

    return this.generateFallbackPlan(goal);
  }

  private async callLLMForReplan(
    goal: string,
    constraints: any,
    currentPlan: any,
    reason: string,
    context?: { failedItemId?: string; failureDetails?: string },
    userPromptContext?: string,
  ): Promise<PlanOutput> {
    const basePrompt = this.buildReplanningPrompt(goal, constraints, currentPlan, reason, context, userPromptContext);
    const maxContractAttempts = 2;

    let lastContractError: PlannerOutputContractViolationError | null = null;

    for (let attempt = 1; attempt <= maxContractAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\n` +
            `CORRECTION REQUIRED:\n` +
            `- Your previous JSON violated the planner-output contract.\n` +
            `- suggestedTools MUST be either [] or a subset of the Allowed tools list. Do not invent tool tokens.\n` +
            `- If a step requires user clarification, set type=USER_INPUT_REQUIRED and suggestedTools=[\"ASK_USER\"] (never \"CHAT\").\n`;

      try {
        const response = await this.callLLM(prompt);
        const parsed = this.parseLLMResponse(response);

        const validation = await this.validatePlan(parsed);
        if (!validation.valid) {
          this.logger.warn(`Replan validation failed: ${validation.errors.join(', ')}`);
          return this.generateFallbackPlan(goal);
        }

        return this.normalizePlanOutput(parsed as PlanOutput, {
          goal,
          mode: 'replan',
          allowedTools: constraints?.allowedTools,
        });
      } catch (error: any) {
        if (error instanceof PlannerFirstStepUserInputError) {
          throw error;
        }

        if (error instanceof PlannerOutputContractViolationError) {
          lastContractError = error;
          this.logger.warn(
            `Planner replan output contract violation on attempt ${attempt}/${maxContractAttempts}: ${error.code}`,
          );
          continue;
        }

        this.logger.error(`LLM replan call failed: ${error.message}`);
        return this.generateFallbackPlan(goal);
      }
    }

    if (lastContractError) {
      throw lastContractError;
    }

    return this.generateFallbackPlan(goal);
  }

  private normalizePlanOutput(
    planOutput: PlanOutput,
    context: { goal: string; mode: 'initial' | 'replan'; allowedTools?: string[] | null },
  ): PlanOutput {
    const maxItems = 20;
    const items = Array.isArray(planOutput.items) ? [...planOutput.items] : [];
    if (items.length === 0) return planOutput;

    const normalizedItems = items.slice(0, maxItems).map((item) => {
      const suggestedTools = normalizeSuggestedToolsOrThrow({
        suggestedTools: item.suggestedTools,
        allowedTools: context.allowedTools,
      });

      if (item.type === StepType.USER_INPUT_REQUIRED) {
        return {
          ...item,
          suggestedTools: ['ASK_USER'],
          requiresDesktop: false,
        };
      }

      return { ...item, suggestedTools };
    });

    const first = normalizedItems[0];
    const reason = detectPlannerFirstStepUserInputReason(first);
    if (reason) {
      throw new PlannerFirstStepUserInputError({ mode: context.mode, firstStep: first, reason });
    }

    // Safety rail: an EXECUTE step may never be "interaction-shaped" anywhere in the plan.
    for (let i = 1; i < normalizedItems.length; i++) {
      const item = normalizedItems[i];
      if (item.type === StepType.EXECUTE && hasUserInteractionTool(item.suggestedTools)) {
        const interactionTool = normalizeSuggestedToolsOrThrow({
          suggestedTools: item.suggestedTools,
          allowedTools: context.allowedTools,
        }).find((t) => hasUserInteractionTool([t]));

        throw new ExecuteStepHasInteractionToolError({
          stepIndex: i,
          stepDescription: item.description,
          interactionTool: interactionTool ?? 'ASK_USER',
        });
      }
    }

    return { ...planOutput, items: normalizedItems };
  }

  private buildPlanningPrompt(goal: string, constraints: any, goalSpecContext?: string): string {
    const allowedTools = constraints?.allowedTools?.join(', ') || 'any';

    return `You are a task planning assistant. Your job is to break down a user's goal into a clear, actionable checklist.

USER GOAL: ${goal}
${goalSpecContext || ''}

CONSTRAINTS:
- Allowed tools: ${allowedTools}
- Workspace mode: ${constraints?.workspaceMode || 'SHARED'}
${constraints?.riskPolicy?.requireApproval?.length ? `- Actions requiring approval: ${constraints.riskPolicy.requireApproval.join(', ')}` : ''}

OUTPUT FORMAT (JSON):
{
  "summary": "Brief description of the plan",
  "items": [
    {
      "description": "Clear, actionable step description",
      "type": "EXECUTE | USER_INPUT_REQUIRED",
      "expectedOutcome": "What should happen when this step succeeds",
      "suggestedTools": ["tool1", "tool2"],
      "requiresDesktop": true/false
    }
  ],
  "confidence": 0.0-1.0
}

RULES:
1. Break the goal into 2-10 discrete, verifiable steps
2. Each step should be independently executable OR explicitly marked as USER_INPUT_REQUIRED
3. Steps should be in logical execution order
4. Include expected outcomes for verification
5. Mark steps requiring desktop interaction
6. suggestedTools MUST be [] or a subset of the Allowed tools list. Never invent tool tokens.
7. If a step requires user clarification, set type=USER_INPUT_REQUIRED, requiresDesktop=false, and include suggestedTools=["ASK_USER"] (never "CHAT")
8. The FIRST step MUST NOT be USER_INPUT_REQUIRED (or suggestedTools=["ASK_USER"]). If clarification is needed to start, assume safe defaults and proceed with an EXECUTE step.
9. Consider potential failure points

Generate the plan:`;
  }

  /**
   * v2.0.0: Context-Preserving Replanning Prompt
   *
   * Key improvements:
   * 1. COMPLETED WORK section: Shows actualOutcome for completed steps
   * 2. Explicit DO NOT REDO instruction: Prevents re-executing completed work
   * 3. BUILD UPON completed results: Uses previous outputs as inputs
   * 4. Manus-style: Keeps completed work "in the model's recent attention span"
   * 5. LangGraph-style: "Don't re-run successful nodes"
   */
  private buildReplanningPrompt(
    goal: string,
    constraints: any,
    currentPlan: any,
    reason: string,
    context?: { failedItemId?: string; failureDetails?: string },
    userPromptContext?: string,
  ): string {
    const checklistItems = currentPlan?.checklistItems || [];

    // v2.0.0: Separate completed items with their actual outcomes
    const completedItems = checklistItems.filter((item: any) => item.status === 'COMPLETED');
    const failedItems = checklistItems.filter((item: any) => item.status === 'FAILED');
    const pendingItems = checklistItems.filter((item: any) =>
      item.status === 'PENDING' || item.status === 'IN_PROGRESS'
    );

    // Build COMPLETED WORK section with actualOutcome (the key fix!)
    let completedWorkSection = '';
    if (completedItems.length > 0) {
      const completedDetails = completedItems.map((item: any) => {
        let entry = `✓ Step ${item.order}: ${item.description}`;
        if (item.actualOutcome) {
          // Parse and format actualOutcome for readability
          let outcome = item.actualOutcome;
          try {
            const parsed = JSON.parse(outcome);
            if (typeof parsed === 'object') {
              outcome = JSON.stringify(parsed, null, 2);
            }
          } catch {
            // Keep as string if not JSON
          }
          entry += `\n   RESULT: ${outcome}`;
        }
        return entry;
      }).join('\n\n');

      completedWorkSection = `
=== COMPLETED WORK (DO NOT REDO) ===
The following steps have ALREADY been completed successfully. Their results are shown below.
DO NOT regenerate or re-execute these steps. Use their results as inputs for remaining work.

${completedDetails}
=== END COMPLETED WORK ===
`;
    }

    // Build FAILED items section
    let failedSection = '';
    if (failedItems.length > 0) {
      const failedDetails = failedItems.map((item: any) => {
        let entry = `✗ Step ${item.order}: ${item.description}`;
        if (item.actualOutcome) {
          entry += `\n   ERROR: ${item.actualOutcome}`;
        }
        return entry;
      }).join('\n\n');

      failedSection = `
=== FAILED STEPS (NEED ALTERNATIVE APPROACH) ===
${failedDetails}
=== END FAILED STEPS ===
`;
    }

    // Build PENDING items section
    let pendingSection = '';
    if (pendingItems.length > 0) {
      const pendingDetails = pendingItems.map((item: any) =>
        `○ Step ${item.order}: ${item.description}`
      ).join('\n');

      pendingSection = `
=== REMAINING STEPS (TO BE REVISED) ===
${pendingDetails}
=== END REMAINING STEPS ===
`;
    }

    const userInteractionSection = userPromptContext
      ? `\n=== USER INTERACTION CONTEXT ===\n${userPromptContext}\n=== END USER INTERACTION CONTEXT ===\n`
      : '';

    return `You are a task planning assistant. A previous plan encountered an issue and needs revision.

USER GOAL: ${goal}
${completedWorkSection}${failedSection}${pendingSection}${userInteractionSection}
FAILURE REASON: ${reason}
${context?.failureDetails ? `FAILURE DETAILS: ${context.failureDetails}` : ''}

CONSTRAINTS:
- Allowed tools: ${constraints?.allowedTools?.join(', ') || 'any'}
- Workspace mode: ${constraints?.workspaceMode || 'SHARED'}

OUTPUT FORMAT (JSON):
{
  "summary": "Brief description of the revised plan",
  "preserveCompletedSteps": true,
  "items": [
    {
      "description": "Clear, actionable step description",
      "type": "EXECUTE | USER_INPUT_REQUIRED",
      "expectedOutcome": "What should happen when this step succeeds",
      "suggestedTools": ["tool1", "tool2"],
      "requiresDesktop": true/false,
      "isPreservedFromPrevious": false
    }
  ],
  "confidence": 0.0-1.0
}

CRITICAL RULES:
1. ⚠️ DO NOT recreate steps that are already COMPLETED - their results are available above
2. If a step depends on completed work, reference the results shown in COMPLETED WORK section
3. Only generate NEW steps for failed/pending work
4. For failed steps, try a different approach (different selector, different website, etc.)
5. Set "isPreservedFromPrevious": true for any steps you're keeping from the original plan
6. The goal is to CONTINUE from where we left off, not start over
7. Be more specific than the previous plan for steps that failed
8. suggestedTools MUST be [] or a subset of the Allowed tools list. Never invent tool tokens.
9. If a step requires user clarification, set type=USER_INPUT_REQUIRED, requiresDesktop=false, and include suggestedTools=["ASK_USER"] (never "CHAT")
10. The FIRST NEW step you generate MUST NOT be USER_INPUT_REQUIRED (or suggestedTools=["ASK_USER"]). If clarification is needed, start with an EXECUTE "preflight" step that extracts assumptions/defaults, then ask the user in a later step.

EXAMPLE OF GOOD REPLANNING:
- If "Search for flights" COMPLETED with results showing "Found $299 on United"
- Then next step should be "Book the $299 United flight" NOT "Search for flights again"

Generate the revised plan that BUILDS UPON completed work:`;
  }

  // PR5: When replanning, include open prompts + resolved answers so the LLM doesn't re-ask
  // and can safely build on user-provided clarifications.
  private formatUserPromptContext(
    prompts: Array<{
      id: string;
      checklistItemId: string | null;
      kind: UserPromptKind;
      status: UserPromptStatus;
      payload: any;
      answers: any;
      createdAt: Date;
      resolvedAt: Date | null;
    }>,
  ): string {
    if (!prompts.length) return '';

    const open = prompts.filter((p) => p.status === UserPromptStatus.OPEN);
    const resolved = prompts.filter((p) => p.status === UserPromptStatus.RESOLVED);

    const toShortJson = (value: any, maxChars: number) => {
      try {
        const str = JSON.stringify(value);
        if (str.length <= maxChars) return str;
        return `${str.slice(0, maxChars)}…`;
      } catch {
        return String(value);
      }
    };

    const lines: string[] = [];

    if (open.length > 0) {
      lines.push('OPEN PROMPTS (awaiting user input):');
      for (const p of open.slice(0, 10)) {
        const reason = p.payload?.reason ?? p.payload?.message ?? null;
        const stepDesc = p.payload?.step?.description ?? p.payload?.title ?? null;
        lines.push(
          `- promptId=${p.id} kind=${p.kind} checklistItemId=${p.checklistItemId ?? 'n/a'}` +
            (stepDesc ? ` step=${JSON.stringify(stepDesc)}` : '') +
            (reason ? ` reason=${JSON.stringify(reason)}` : ''),
        );
      }
    }

    if (resolved.length > 0) {
      lines.push('RESOLVED PROMPTS (user-provided answers):');
      for (const p of resolved.slice(-10)) {
        const ts = p.resolvedAt ? p.resolvedAt.toISOString() : p.createdAt.toISOString();
        lines.push(
          `- promptId=${p.id} kind=${p.kind} checklistItemId=${p.checklistItemId ?? 'n/a'} at=${ts} answers=${toShortJson(p.answers, 1200)}`,
        );
      }
    }

    return lines.join('\n');
  }

  private async callLLM(prompt: string): Promise<string> {
    // If no API key, use mock response for development
    if (!this.llmApiKey) {
      this.logger.warn('No LLM API key configured, using mock response');
      return this.getMockLLMResponse(prompt);
    }

    const response = await fetch(this.llmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.llmModel,
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  private parseLLMResponse(response: string): unknown {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    try {
      return JSON.parse(jsonStr.trim());
    } catch {
      // Try to find JSON object in response
      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }
      throw new Error('Failed to parse LLM response as JSON');
    }
  }

  private generateFallbackPlan(goal: string): PlanOutput {
    // Generate a simple fallback plan based on the goal
    return {
      summary: `Execute goal: ${goal.substring(0, 100)}`,
      items: [
        {
          description: `Analyze the goal: "${goal.substring(0, 200)}"`,
          type: StepType.EXECUTE,
          expectedOutcome: 'Understanding of required actions',
          suggestedTools: [],
          requiresDesktop: false,
        },
        {
          description: 'Execute the primary action required by the goal',
          type: StepType.EXECUTE,
          expectedOutcome: 'Goal objective achieved',
          suggestedTools: ['browser'],
          requiresDesktop: true,
        },
        {
          description: 'Verify the goal was accomplished successfully',
          type: StepType.EXECUTE,
          expectedOutcome: 'Confirmation of success',
          suggestedTools: ['screenshot'],
          requiresDesktop: true,
        },
      ],
      confidence: 0.5,
    };
  }

  private getMockLLMResponse(prompt: string): string {
    // Extract goal from prompt for mock response
    const goalMatch = prompt.match(/USER GOAL: (.+?)(?:\n|CONSTRAINTS)/s);
    const goal = goalMatch ? goalMatch[1].trim() : 'Unknown goal';

    // Generate mock plan based on common patterns
    const isLoginTask = goal.toLowerCase().includes('login') || goal.toLowerCase().includes('log in');
    const isDownloadTask = goal.toLowerCase().includes('download');
    const isEmailTask = goal.toLowerCase().includes('email');

    let items: any[] = [];

    if (isLoginTask) {
      items = [
        { description: 'Open the target website in browser', type: StepType.EXECUTE, expectedOutcome: 'Website loaded', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Locate and click the login button/link', type: StepType.EXECUTE, expectedOutcome: 'Login form visible', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Enter credentials and submit', type: StepType.EXECUTE, expectedOutcome: 'Successfully logged in', suggestedTools: ['browser'], requiresDesktop: true },
      ];
    } else if (isDownloadTask) {
      items = [
        { description: 'Navigate to the download location', type: StepType.EXECUTE, expectedOutcome: 'Download page visible', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Locate the download link/button', type: StepType.EXECUTE, expectedOutcome: 'Download option found', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Click download and wait for completion', type: StepType.EXECUTE, expectedOutcome: 'File downloaded', suggestedTools: ['browser', 'file_download'], requiresDesktop: true },
      ];
    } else if (isEmailTask) {
      items = [
        { description: 'Open email client or webmail', type: StepType.EXECUTE, expectedOutcome: 'Email interface ready', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Compose new email with required content', type: StepType.EXECUTE, expectedOutcome: 'Email composed', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Review and send the email', type: StepType.EXECUTE, expectedOutcome: 'Email sent successfully', suggestedTools: ['browser', 'email'], requiresDesktop: true },
      ];
    } else {
      items = [
        { description: 'Analyze and understand the goal requirements', type: StepType.EXECUTE, expectedOutcome: 'Clear understanding of tasks', suggestedTools: [], requiresDesktop: false },
        { description: 'Execute the main action for the goal', type: StepType.EXECUTE, expectedOutcome: 'Primary objective completed', suggestedTools: ['browser'], requiresDesktop: true },
        { description: 'Verify successful completion', type: StepType.EXECUTE, expectedOutcome: 'Goal achieved', suggestedTools: ['screenshot'], requiresDesktop: true },
      ];
    }

    return JSON.stringify({
      summary: `Plan to: ${goal.substring(0, 100)}`,
      items,
      confidence: 0.75,
    });
  }
}
