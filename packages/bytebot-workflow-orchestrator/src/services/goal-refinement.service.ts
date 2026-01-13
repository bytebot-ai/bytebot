/**
 * Goal Refinement Service
 * Phase 9 (v5.4.0): Advanced AI Features
 *
 * Responsibilities:
 * - Analyze vague/ambiguous goals
 * - Generate refined SMART goal suggestions
 * - Provide clarifying questions for ambiguity
 * - Estimate goal complexity and feasibility
 * - Decompose complex goals into sub-goals
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { z } from 'zod';

// Zod schemas for LLM output validation
const RefinedGoalSchema = z.object({
  refined: z.string().min(10).max(1000),
  reasoning: z.string().optional(),
  improvements: z.array(z.string()).optional(),
  specificity: z.number().min(0).max(1).optional(),
});

const GoalRefinementOutputSchema = z.object({
  originalAnalysis: z.object({
    clarity: z.number().min(0).max(1),
    specificity: z.number().min(0).max(1),
    actionability: z.number().min(0).max(1),
    measurability: z.number().min(0).max(1),
    issues: z.array(z.string()),
  }),
  refinedSuggestions: z.array(RefinedGoalSchema).min(1).max(5),
  clarifyingQuestions: z.array(z.string()).max(5).optional(),
  decomposition: z.array(z.object({
    subGoal: z.string(),
    order: z.number(),
    dependency: z.string().optional(),
  })).optional(),
  estimatedComplexity: z.enum(['simple', 'moderate', 'complex', 'very_complex']).optional(),
  suggestedConstraints: z.record(z.any()).optional(),
});

type GoalRefinementOutput = z.infer<typeof GoalRefinementOutputSchema>;

// Public interfaces
export interface RefinementRequest {
  tenantId: string;
  goal: string;
  context?: {
    previousGoals?: string[];
    userPreferences?: Record<string, any>;
    domain?: string;
  };
  options?: {
    maxSuggestions?: number;
    includeQuestions?: boolean;
    includeDecomposition?: boolean;
    style?: 'concise' | 'detailed' | 'technical';
  };
}

export interface RefinementResult {
  originalGoal: string;
  analysis: {
    clarity: number;
    specificity: number;
    actionability: number;
    measurability: number;
    overallScore: number;
    issues: string[];
  };
  suggestions: Array<{
    refinedGoal: string;
    reasoning?: string;
    improvements?: string[];
    matchScore: number;
  }>;
  clarifyingQuestions?: string[];
  decomposition?: Array<{
    subGoal: string;
    order: number;
    dependency?: string;
  }>;
  complexity: 'simple' | 'moderate' | 'complex' | 'very_complex';
  suggestedConstraints?: Record<string, any>;
  tokensUsed?: number;
  cached: boolean;
}

export interface QuickAnalysisResult {
  clarity: number;
  specificity: number;
  actionability: number;
  issues: string[];
  needsRefinement: boolean;
}

@Injectable()
export class GoalRefinementService {
  private readonly logger = new Logger(GoalRefinementService.name);
  private readonly llmModel: string;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;
  private readonly cacheEnabled: boolean;
  private readonly cacheTTLMs: number;

  // Simple in-memory cache for goal analysis
  private analysisCache = new Map<string, { result: RefinementResult; timestamp: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.cacheEnabled = this.configService.get('GOAL_REFINEMENT_CACHE_ENABLED', 'true') === 'true';
    this.cacheTTLMs = parseInt(this.configService.get('GOAL_REFINEMENT_CACHE_TTL_MS', '3600000'), 10); // 1 hour default

    this.logger.log('GoalRefinementService initialized');
  }

  /**
   * Analyze and refine a goal
   */
  async refineGoal(request: RefinementRequest): Promise<RefinementResult> {
    const { tenantId, goal, context, options } = request;

    this.logger.log(`Refining goal for tenant ${tenantId}: "${goal.substring(0, 50)}..."`);

    // Check cache
    const cacheKey = this.getCacheKey(goal, options);
    if (this.cacheEnabled) {
      const cached = this.analysisCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.cacheTTLMs) {
        this.logger.debug('Returning cached refinement result');
        return { ...cached.result, cached: true };
      }
    }

    // Build and execute LLM prompt
    const prompt = this.buildRefinementPrompt(goal, context, options);

    try {
      const llmResponse = await this.callLLM(prompt);
      const parsed = this.parseLLMResponse(llmResponse);

      // Validate response
      const validated = GoalRefinementOutputSchema.safeParse(parsed);

      let result: RefinementResult;

      if (validated.success) {
        result = this.transformToResult(goal, validated.data);
      } else {
        this.logger.warn(`LLM response validation failed: ${validated.error.message}`);
        result = this.generateFallbackResult(goal);
      }

      // Cache result
      if (this.cacheEnabled) {
        this.analysisCache.set(cacheKey, { result, timestamp: Date.now() });
      }

      // Emit event
      this.eventEmitter.emit('goal-refinement.completed', {
        tenantId,
        originalGoal: goal,
        suggestionsCount: result.suggestions.length,
        overallScore: result.analysis.overallScore,
      });

      // Store refinement record
      await this.storeRefinementRecord(tenantId, goal, result);

      return result;
    } catch (error: any) {
      this.logger.error(`Goal refinement failed: ${error.message}`);

      // Emit failure event
      this.eventEmitter.emit('goal-refinement.failed', {
        tenantId,
        originalGoal: goal,
        error: error.message,
      });

      // Return fallback
      return this.generateFallbackResult(goal);
    }
  }

  /**
   * Quick analysis without full refinement (heuristic-based)
   */
  async quickAnalyze(goal: string): Promise<QuickAnalysisResult> {
    const lowerGoal = goal.toLowerCase().trim();
    const issues: string[] = [];

    // Clarity check - is it understandable?
    let clarity = 1.0;
    if (goal.length < 10) {
      clarity -= 0.4;
      issues.push('Goal is too short to be clear');
    }
    if (goal.split(' ').length < 3) {
      clarity -= 0.2;
      issues.push('Goal needs more descriptive words');
    }
    if (/\?$/.test(goal)) {
      clarity -= 0.1;
      issues.push('Goal should be a statement, not a question');
    }

    // Specificity check - does it have concrete details?
    let specificity = 1.0;
    const vagueWords = ['something', 'stuff', 'thing', 'things', 'somehow', 'whatever', 'etc'];
    const vagueCount = vagueWords.filter(w => lowerGoal.includes(w)).length;
    specificity -= vagueCount * 0.15;
    if (vagueCount > 0) {
      issues.push('Goal contains vague words that should be made specific');
    }

    // Check for quantifiable elements
    const hasNumbers = /\d+/.test(goal);
    const hasTimeframe = /\b(today|tomorrow|week|month|hour|minute|by|before|after|until)\b/i.test(goal);
    if (!hasNumbers && !hasTimeframe) {
      specificity -= 0.2;
      issues.push('Consider adding specific quantities or timeframes');
    }

    // Actionability check - does it start with an action verb?
    let actionability = 1.0;
    const actionVerbs = [
      'create', 'build', 'write', 'send', 'download', 'upload', 'login', 'log in',
      'navigate', 'open', 'search', 'find', 'update', 'delete', 'add', 'remove',
      'configure', 'setup', 'set up', 'install', 'deploy', 'test', 'verify',
      'analyze', 'review', 'check', 'monitor', 'generate', 'export', 'import',
    ];
    const startsWithAction = actionVerbs.some(v => lowerGoal.startsWith(v));
    if (!startsWithAction) {
      actionability -= 0.3;
      issues.push('Goal should start with an action verb');
    }

    // Measurability - can success be determined?
    let measurability = 0.7; // Default
    const measurableIndicators = [
      'successfully', 'complete', 'finish', 'ensure', 'verify', 'confirm',
      'all', 'each', 'every', 'must', 'should', 'will'
    ];
    const hasMeasurable = measurableIndicators.some(i => lowerGoal.includes(i));
    if (hasMeasurable) {
      measurability = 0.9;
    }

    // Clamp values
    clarity = Math.max(0, Math.min(1, clarity));
    specificity = Math.max(0, Math.min(1, specificity));
    actionability = Math.max(0, Math.min(1, actionability));
    measurability = Math.max(0, Math.min(1, measurability));

    const avgScore = (clarity + specificity + actionability + measurability) / 4;
    const needsRefinement = avgScore < 0.7 || issues.length > 2;

    return {
      clarity,
      specificity,
      actionability,
      issues,
      needsRefinement,
    };
  }

  /**
   * Get refinement suggestions based on historical patterns
   */
  async getSuggestionsFromHistory(
    tenantId: string,
    partialGoal: string,
    limit: number = 5,
  ): Promise<Array<{ goal: string; similarity: number; usageCount: number }>> {
    // Find similar successful goals from history
    const recentGoals = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
      },
      select: {
        goal: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Simple similarity scoring based on word overlap
    const partialWords = new Set(partialGoal.toLowerCase().split(/\s+/));

    const scored = recentGoals.map(g => {
      const goalWords = new Set(g.goal.toLowerCase().split(/\s+/));
      const intersection = [...partialWords].filter(w => goalWords.has(w));
      const similarity = intersection.length / Math.max(partialWords.size, goalWords.size);
      return { goal: g.goal, similarity };
    });

    // Count occurrences and sort by similarity
    const goalCounts = new Map<string, number>();
    scored.forEach(s => {
      goalCounts.set(s.goal, (goalCounts.get(s.goal) || 0) + 1);
    });

    const unique = [...new Map(scored.map(s => [s.goal, s])).values()];

    return unique
      .filter(s => s.similarity > 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(s => ({
        goal: s.goal,
        similarity: Math.round(s.similarity * 100) / 100,
        usageCount: goalCounts.get(s.goal) || 1,
      }));
  }

  /**
   * Decompose a complex goal into sub-goals
   */
  async decomposeGoal(
    tenantId: string,
    goal: string,
    maxSubGoals: number = 5,
  ): Promise<Array<{ subGoal: string; order: number; estimatedDuration?: string }>> {
    const prompt = this.buildDecompositionPrompt(goal, maxSubGoals);

    try {
      const response = await this.callLLM(prompt);
      const parsed = this.parseLLMResponse(response);

      if (Array.isArray(parsed.subGoals)) {
        return parsed.subGoals.map((sg: any, idx: number) => ({
          subGoal: sg.goal || sg.subGoal || sg,
          order: sg.order || idx + 1,
          estimatedDuration: sg.duration || sg.estimatedDuration,
        }));
      }

      return this.generateFallbackDecomposition(goal);
    } catch (error: any) {
      this.logger.error(`Goal decomposition failed: ${error.message}`);
      return this.generateFallbackDecomposition(goal);
    }
  }

  // Private methods

  private buildRefinementPrompt(
    goal: string,
    context?: RefinementRequest['context'],
    options?: RefinementRequest['options'],
  ): string {
    const style = options?.style || 'detailed';
    const maxSuggestions = options?.maxSuggestions || 3;
    const includeQuestions = options?.includeQuestions !== false;
    const includeDecomposition = options?.includeDecomposition !== false;

    let prompt = `You are an expert goal analyst. Analyze the following user goal and provide refinement suggestions.

USER GOAL: "${goal}"

${context?.domain ? `DOMAIN CONTEXT: ${context.domain}` : ''}
${context?.previousGoals?.length ? `PREVIOUS GOALS BY USER:\n${context.previousGoals.slice(0, 3).join('\n')}` : ''}

ANALYSIS TASK:
1. Evaluate the goal on these dimensions (0-1 scale):
   - Clarity: Is it unambiguous and easy to understand?
   - Specificity: Does it have concrete, measurable elements?
   - Actionability: Can it be directly executed?
   - Measurability: Can success be objectively determined?

2. Identify any issues with the goal (vagueness, ambiguity, missing context).

3. Provide ${maxSuggestions} refined versions of the goal that are SMART:
   - Specific: Well-defined and clear
   - Measurable: Quantifiable outcome
   - Achievable: Realistic scope
   - Relevant: Maintains original intent
   - Time-bound: Has implicit or explicit timeframe

${includeQuestions ? '4. Generate clarifying questions that would help refine the goal further.' : ''}

${includeDecomposition ? '5. If the goal is complex, break it into ordered sub-goals.' : ''}

6. Estimate complexity: simple, moderate, complex, or very_complex

7. Suggest any constraints that might be helpful (workspace mode, required tools, etc.)

OUTPUT FORMAT (JSON):
{
  "originalAnalysis": {
    "clarity": 0.0-1.0,
    "specificity": 0.0-1.0,
    "actionability": 0.0-1.0,
    "measurability": 0.0-1.0,
    "issues": ["issue1", "issue2"]
  },
  "refinedSuggestions": [
    {
      "refined": "Improved goal text",
      "reasoning": "Why this is better",
      "improvements": ["improvement1", "improvement2"],
      "specificity": 0.0-1.0
    }
  ],
  ${includeQuestions ? '"clarifyingQuestions": ["question1", "question2"],' : ''}
  ${includeDecomposition ? '"decomposition": [{"subGoal": "...", "order": 1, "dependency": null}],' : ''}
  "estimatedComplexity": "simple|moderate|complex|very_complex",
  "suggestedConstraints": {}
}

${style === 'concise' ? 'Keep suggestions concise and direct.' : ''}
${style === 'technical' ? 'Use technical language appropriate for automation.' : ''}

Analyze and refine the goal:`;

    return prompt;
  }

  private buildDecompositionPrompt(goal: string, maxSubGoals: number): string {
    return `Break down this goal into ${maxSubGoals} or fewer sequential sub-goals:

GOAL: "${goal}"

OUTPUT FORMAT (JSON):
{
  "subGoals": [
    {"goal": "Sub-goal 1", "order": 1, "duration": "estimated time"},
    {"goal": "Sub-goal 2", "order": 2, "duration": "estimated time"}
  ]
}

Each sub-goal should be:
- Independently verifiable
- In logical execution order
- Specific and actionable

Decompose the goal:`;
  }

  private async callLLM(prompt: string): Promise<string> {
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
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  private parseLLMResponse(response: string): any {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    try {
      return JSON.parse(jsonStr.trim());
    } catch {
      const objectMatch = response.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        return JSON.parse(objectMatch[0]);
      }
      throw new Error('Failed to parse LLM response as JSON');
    }
  }

  private transformToResult(
    originalGoal: string,
    output: GoalRefinementOutput,
  ): RefinementResult {
    const analysis = output.originalAnalysis;
    const overallScore = (
      analysis.clarity +
      analysis.specificity +
      analysis.actionability +
      analysis.measurability
    ) / 4;

    return {
      originalGoal,
      analysis: {
        ...analysis,
        overallScore: Math.round(overallScore * 100) / 100,
      },
      suggestions: output.refinedSuggestions.map((s, idx) => ({
        refinedGoal: s.refined,
        reasoning: s.reasoning,
        improvements: s.improvements,
        matchScore: s.specificity || (1 - idx * 0.1), // First suggestion is best
      })),
      clarifyingQuestions: output.clarifyingQuestions,
      decomposition: output.decomposition,
      complexity: output.estimatedComplexity || 'moderate',
      suggestedConstraints: output.suggestedConstraints,
      cached: false,
    };
  }

  private generateFallbackResult(goal: string): RefinementResult {
    const quickAnalysis = this.quickAnalyzeSync(goal);

    return {
      originalGoal: goal,
      analysis: {
        clarity: quickAnalysis.clarity,
        specificity: quickAnalysis.specificity,
        actionability: quickAnalysis.actionability,
        measurability: 0.7,
        overallScore: (quickAnalysis.clarity + quickAnalysis.specificity + quickAnalysis.actionability + 0.7) / 4,
        issues: quickAnalysis.issues,
      },
      suggestions: [
        {
          refinedGoal: goal,
          reasoning: 'Original goal (analysis unavailable)',
          matchScore: 1.0,
        },
      ],
      complexity: 'moderate',
      cached: false,
    };
  }

  private quickAnalyzeSync(goal: string): { clarity: number; specificity: number; actionability: number; issues: string[] } {
    const issues: string[] = [];
    let clarity = goal.length >= 10 ? 0.8 : 0.5;
    let specificity = goal.length >= 20 ? 0.7 : 0.5;
    let actionability = 0.7;

    if (goal.length < 10) issues.push('Goal is too short');
    if (!/^[A-Z]/.test(goal) && !/^[a-z]+\s/.test(goal)) issues.push('Goal should start with action verb');

    return { clarity, specificity, actionability, issues };
  }

  private generateFallbackDecomposition(goal: string): Array<{ subGoal: string; order: number }> {
    return [
      { subGoal: `Understand requirements for: ${goal.substring(0, 50)}`, order: 1 },
      { subGoal: 'Execute the main objective', order: 2 },
      { subGoal: 'Verify successful completion', order: 3 },
    ];
  }

  private getCacheKey(goal: string, options?: RefinementRequest['options']): string {
    const normalized = goal.toLowerCase().trim();
    const optionsKey = JSON.stringify(options || {});
    return `${normalized}::${optionsKey}`;
  }

  private async storeRefinementRecord(
    tenantId: string,
    originalGoal: string,
    result: RefinementResult,
  ): Promise<void> {
    try {
      await this.prisma.goalRefinementSuggestion.create({
        data: {
          tenantId,
          originalGoal,
          analysisScore: result.analysis.overallScore,
          suggestionsCount: result.suggestions.length,
          topSuggestion: result.suggestions[0]?.refinedGoal || originalGoal,
          complexity: result.complexity,
          issues: result.analysis.issues,
        },
      });
    } catch (error: any) {
      // Log but don't fail if storage fails
      this.logger.warn(`Failed to store refinement record: ${error.message}`);
    }
  }

  private getMockLLMResponse(prompt: string): string {
    const goalMatch = prompt.match(/USER GOAL: "(.+?)"/);
    const goal = goalMatch ? goalMatch[1] : 'Unknown goal';

    return JSON.stringify({
      originalAnalysis: {
        clarity: 0.7,
        specificity: 0.6,
        actionability: 0.8,
        measurability: 0.5,
        issues: ['Could be more specific', 'Consider adding measurable criteria'],
      },
      refinedSuggestions: [
        {
          refined: `${goal} with specific success criteria and verification`,
          reasoning: 'Added measurability',
          improvements: ['Added success criteria', 'Made outcome verifiable'],
          specificity: 0.9,
        },
        {
          refined: `Complete the following: ${goal}`,
          reasoning: 'Made more actionable',
          improvements: ['Added action verb'],
          specificity: 0.8,
        },
      ],
      clarifyingQuestions: [
        'What specific outcome are you looking for?',
        'Are there any constraints or preferences?',
      ],
      estimatedComplexity: 'moderate',
      suggestedConstraints: {
        workspaceMode: 'SHARED',
      },
    });
  }
}
