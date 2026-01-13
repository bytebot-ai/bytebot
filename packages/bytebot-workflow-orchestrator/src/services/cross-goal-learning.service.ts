/**
 * Cross-Goal Learning Service
 * v1.0.0: Knowledge Transfer Between Related Goals
 *
 * Implements industry-standard patterns for learning across tasks:
 * - AutoGPT: Memory persistence and retrieval across sessions
 * - MemGPT: Hierarchical memory with LLM-managed recall
 * - LangChain: Experience replay and chain-of-thought caching
 *
 * Key Features:
 * 1. Goal similarity detection (semantic and structural)
 * 2. Success pattern transfer from past goals
 * 3. Failure avoidance from learned mistakes
 * 4. Reusable step/plan suggestions
 * 5. Context injection from related past executions
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS_V2.md
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { KnowledgeExtractionService, ExtractedFact } from './knowledge-extraction.service';
import { EntityResolutionService, ResolvedEntity } from './entity-resolution.service';

// Goal Similarity Result
export interface GoalSimilarity {
  goalRunId: string;
  goalDescription: string;
  similarityScore: number; // 0-1
  matchType: 'semantic' | 'structural' | 'entity' | 'outcome';
  relevantFacts: ExtractedFact[];
  relevantEntities: ResolvedEntity[];
  status: string;
  outcome?: string;
}

// Learned Experience
export interface LearnedExperience {
  id: string;
  goalRunId: string;
  goalDescription: string;
  experienceType: 'success_pattern' | 'failure_lesson' | 'optimization' | 'shortcut';
  description: string;
  applicableWhen: string[]; // Conditions when this applies
  steps?: Array<{
    order: number;
    description: string;
    outcome: string;
  }>;
  impact: 'high' | 'medium' | 'low';
  usageCount: number;
  lastUsedAt?: Date;
  createdAt: Date;
}

// Context Suggestion for new goals
export interface ContextSuggestion {
  source: 'past_goal' | 'learned_experience' | 'entity_knowledge';
  content: string;
  relevance: number; // 0-1
  sourceGoalId?: string;
  experienceId?: string;
}

// Learning Summary
export interface LearningSummary {
  totalExperiences: number;
  successPatterns: number;
  failureLessons: number;
  optimizations: number;
  averageReuse: number;
  topExperiences: LearnedExperience[];
}

@Injectable()
export class CrossGoalLearningService implements OnModuleInit {
  private readonly logger = new Logger(CrossGoalLearningService.name);
  private readonly enabled: boolean;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;

  // Learned experiences storage
  private experiences: Map<string, LearnedExperience> = new Map();

  // Goal embeddings cache (for similarity)
  private goalEmbeddings: Map<string, { text: string; tokens: string[] }> = new Map();

  // Configuration
  private readonly minSimilarityThreshold: number;
  private readonly maxSimilarGoals: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly knowledgeService: KnowledgeExtractionService,
    private readonly entityService: EntityResolutionService,
  ) {
    this.enabled = this.configService.get('CROSS_GOAL_LEARNING_ENABLED', 'true') === 'true';
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.minSimilarityThreshold = parseFloat(this.configService.get('GOAL_SIMILARITY_THRESHOLD', '0.6'));
    this.maxSimilarGoals = parseInt(this.configService.get('MAX_SIMILAR_GOALS', '5'), 10);

    this.logger.log(`Cross-goal learning ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Load experiences from database
    await this.loadExperiences();

    // Build goal embeddings index
    await this.buildGoalIndex();

    this.logger.log(`Cross-goal learning initialized with ${this.experiences.size} experiences`);
  }

  /**
   * Find similar past goals for a new goal
   */
  async findSimilarGoals(
    goalDescription: string,
    tenantId?: string,
  ): Promise<GoalSimilarity[]> {
    if (!this.enabled) return [];

    const queryTokens = this.tokenize(goalDescription);
    const similarities: GoalSimilarity[] = [];

    // Search through indexed goals
    for (const [goalRunId, embedding] of this.goalEmbeddings) {
      const similarity = this.calculateTextSimilarity(queryTokens, embedding.tokens);

      if (similarity >= this.minSimilarityThreshold) {
        // Get goal details
        try {
          const goalRun = await this.prisma.goalRun.findUnique({
            where: { id: goalRunId },
            select: {
              id: true,
              goal: true,
              status: true,
              error: true,
              tenantId: true,
            },
          });

          if (!goalRun) continue;

          // Filter by tenant if specified
          if (tenantId && goalRun.tenantId !== tenantId) continue;

          // Get relevant knowledge
          const knowledge = this.knowledgeService.getKnowledge(goalRunId);
          const entities = this.entityService.getResolvedEntities(goalRunId);

          similarities.push({
            goalRunId: goalRun.id,
            goalDescription: goalRun.goal,
            similarityScore: similarity,
            matchType: 'semantic',
            relevantFacts: knowledge?.facts.slice(0, 5) || [],
            relevantEntities: entities.slice(0, 5),
            status: goalRun.status,
            outcome: goalRun.error || undefined,
          });
        } catch (error) {
          // Skip goals that can't be loaded
        }
      }
    }

    // Sort by similarity and limit
    return similarities
      .sort((a, b) => b.similarityScore - a.similarityScore)
      .slice(0, this.maxSimilarGoals);
  }

  /**
   * Get context suggestions for a new goal based on past executions
   */
  async getSuggestions(
    goalDescription: string,
    tenantId?: string,
  ): Promise<ContextSuggestion[]> {
    const suggestions: ContextSuggestion[] = [];

    // Find similar goals
    const similarGoals = await this.findSimilarGoals(goalDescription, tenantId);

    // Add suggestions from successful similar goals
    for (const similar of similarGoals) {
      if (similar.status === 'COMPLETED') {
        suggestions.push({
          source: 'past_goal',
          content: `Similar goal "${similar.goalDescription.substring(0, 50)}..." completed successfully`,
          relevance: similar.similarityScore,
          sourceGoalId: similar.goalRunId,
        });

        // Add key facts from similar goal
        for (const fact of similar.relevantFacts.slice(0, 2)) {
          suggestions.push({
            source: 'entity_knowledge',
            content: fact.content,
            relevance: similar.similarityScore * fact.confidence,
            sourceGoalId: similar.goalRunId,
          });
        }
      }
    }

    // Add suggestions from learned experiences
    const relevantExperiences = this.findRelevantExperiences(goalDescription);
    for (const exp of relevantExperiences) {
      suggestions.push({
        source: 'learned_experience',
        content: exp.description,
        relevance: 0.8,
        experienceId: exp.id,
      });
    }

    // Sort by relevance and deduplicate
    return suggestions
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 10);
  }

  /**
   * Format suggestions as context for LLM
   */
  async formatSuggestionsForLLM(
    goalDescription: string,
    tenantId?: string,
    maxTokens: number = 1000,
  ): Promise<string> {
    const suggestions = await this.getSuggestions(goalDescription, tenantId);

    if (suggestions.length === 0) {
      return '';
    }

    const lines: string[] = ['=== LEARNED FROM PAST GOALS ==='];

    // Group by source
    const pastGoals = suggestions.filter(s => s.source === 'past_goal');
    const experiences = suggestions.filter(s => s.source === 'learned_experience');
    const knowledge = suggestions.filter(s => s.source === 'entity_knowledge');

    if (pastGoals.length > 0) {
      lines.push('\nSimilar Past Goals:');
      for (const pg of pastGoals.slice(0, 3)) {
        lines.push(`- ${pg.content} (${Math.round(pg.relevance * 100)}% similar)`);
      }
    }

    if (experiences.length > 0) {
      lines.push('\nLearned Experiences:');
      for (const exp of experiences.slice(0, 3)) {
        lines.push(`- ${exp.content}`);
      }
    }

    if (knowledge.length > 0) {
      lines.push('\nRelevant Knowledge:');
      for (const k of knowledge.slice(0, 3)) {
        lines.push(`- ${k.content}`);
      }
    }

    lines.push('\n=== END LEARNED ===');

    // Truncate if too long
    let result = lines.join('\n');
    const maxChars = maxTokens * 4;
    if (result.length > maxChars) {
      result = result.substring(0, maxChars - 50) + '\n... (truncated)';
    }

    return result;
  }

  /**
   * Learn from a completed goal
   */
  @OnEvent('goal.completed')
  async handleGoalCompleted(payload: { goalRunId: string }): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.learnFromGoal(payload.goalRunId, 'success');
    } catch (error) {
      this.logger.warn(`Failed to learn from completed goal: ${(error as Error).message}`);
    }
  }

  /**
   * Learn from a failed goal
   */
  @OnEvent('goal.failed')
  async handleGoalFailed(payload: { goalRunId: string; reason?: string }): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.learnFromGoal(payload.goalRunId, 'failure');
    } catch (error) {
      this.logger.warn(`Failed to learn from failed goal: ${(error as Error).message}`);
    }
  }

  /**
   * Record usage of an experience
   */
  recordExperienceUsage(experienceId: string): void {
    const exp = this.experiences.get(experienceId);
    if (exp) {
      exp.usageCount++;
      exp.lastUsedAt = new Date();
    }
  }

  /**
   * Get learning summary
   */
  getLearningSummary(): LearningSummary {
    const experiences = Array.from(this.experiences.values());

    const successPatterns = experiences.filter(e => e.experienceType === 'success_pattern').length;
    const failureLessons = experiences.filter(e => e.experienceType === 'failure_lesson').length;
    const optimizations = experiences.filter(e => e.experienceType === 'optimization').length;

    const totalUsage = experiences.reduce((sum, e) => sum + e.usageCount, 0);
    const averageReuse = experiences.length > 0 ? totalUsage / experiences.length : 0;

    const topExperiences = experiences
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 5);

    return {
      totalExperiences: experiences.length,
      successPatterns,
      failureLessons,
      optimizations,
      averageReuse,
      topExperiences,
    };
  }

  /**
   * Get all experiences
   */
  getAllExperiences(): LearnedExperience[] {
    return Array.from(this.experiences.values());
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private async loadExperiences(): Promise<void> {
    try {
      // Load from completed goals with good outcomes
      const recentSuccesses = await this.prisma.goalRun.findMany({
        where: {
          status: 'COMPLETED',
          completedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // Last 30 days
        },
        include: {
          planVersions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              checklistItems: {
                where: { status: 'COMPLETED' },
                orderBy: { order: 'asc' },
              },
            },
          },
        },
        take: 100,
      });

      for (const goal of recentSuccesses) {
        const plan = goal.planVersions[0];
        if (!plan || plan.checklistItems.length < 2) continue;

        const experience: LearnedExperience = {
          id: `exp-${goal.id}`,
          goalRunId: goal.id,
          goalDescription: goal.goal,
          experienceType: 'success_pattern',
          description: `Successfully completed: ${goal.goal.substring(0, 100)}`,
          applicableWhen: this.extractApplicableConditions(goal.goal),
          steps: plan.checklistItems.map(item => ({
            order: item.order,
            description: item.description,
            outcome: item.actualOutcome || 'Completed',
          })),
          impact: 'medium',
          usageCount: 0,
          createdAt: goal.completedAt || goal.createdAt,
        };

        this.experiences.set(experience.id, experience);
      }

      // Also load failure lessons
      const recentFailures = await this.prisma.goalRun.findMany({
        where: {
          status: 'FAILED',
          completedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        select: {
          id: true,
          goal: true,
          error: true,
          completedAt: true,
          createdAt: true,
        },
        take: 50,
      });

      for (const goal of recentFailures) {
        if (!goal.error) continue;

        const experience: LearnedExperience = {
          id: `exp-fail-${goal.id}`,
          goalRunId: goal.id,
          goalDescription: goal.goal,
          experienceType: 'failure_lesson',
          description: `Avoid: ${goal.error.substring(0, 100)}`,
          applicableWhen: this.extractApplicableConditions(goal.goal),
          impact: 'high',
          usageCount: 0,
          createdAt: goal.completedAt || goal.createdAt,
        };

        this.experiences.set(experience.id, experience);
      }
    } catch (error) {
      this.logger.warn(`Failed to load experiences: ${(error as Error).message}`);
    }
  }

  private async buildGoalIndex(): Promise<void> {
    try {
      const recentGoals = await this.prisma.goalRun.findMany({
        where: {
          status: { in: ['COMPLETED', 'FAILED'] },
          createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) }, // Last 60 days
        },
        select: {
          id: true,
          goal: true,
        },
        take: 500,
      });

      for (const goal of recentGoals) {
        this.goalEmbeddings.set(goal.id, {
          text: goal.goal,
          tokens: this.tokenize(goal.goal),
        });
      }

      this.logger.debug(`Built goal index with ${this.goalEmbeddings.size} entries`);
    } catch (error) {
      this.logger.warn(`Failed to build goal index: ${(error as Error).message}`);
    }
  }

  private async learnFromGoal(goalRunId: string, outcome: 'success' | 'failure'): Promise<void> {
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

    if (!goalRun) return;

    // Add to embeddings index
    this.goalEmbeddings.set(goalRunId, {
      text: goalRun.goal,
      tokens: this.tokenize(goalRun.goal),
    });

    // Create experience
    const plan = goalRun.planVersions[0];
    const experienceId = `exp-${outcome === 'success' ? '' : 'fail-'}${goalRunId}`;

    const experience: LearnedExperience = {
      id: experienceId,
      goalRunId,
      goalDescription: goalRun.goal,
      experienceType: outcome === 'success' ? 'success_pattern' : 'failure_lesson',
      description: outcome === 'success'
        ? `Completed: ${goalRun.goal.substring(0, 100)}`
        : `Failed: ${goalRun.error?.substring(0, 100) || 'Unknown reason'}`,
      applicableWhen: this.extractApplicableConditions(goalRun.goal),
      steps: outcome === 'success' && plan
        ? plan.checklistItems.map(item => ({
            order: item.order,
            description: item.description,
            outcome: item.actualOutcome || 'Completed',
          }))
        : undefined,
      impact: outcome === 'failure' ? 'high' : 'medium',
      usageCount: 0,
      createdAt: new Date(),
    };

    this.experiences.set(experienceId, experience);

    this.logger.debug(`Learned ${outcome} experience from goal ${goalRunId}`);

    // Emit event
    this.eventEmitter.emit('learning.experience.created', {
      experienceId,
      goalRunId,
      type: experience.experienceType,
    });
  }

  private findRelevantExperiences(goalDescription: string): LearnedExperience[] {
    const queryTokens = this.tokenize(goalDescription);
    const relevant: Array<{ exp: LearnedExperience; score: number }> = [];

    for (const exp of this.experiences.values()) {
      // Check if any applicable conditions match
      const conditionScore = exp.applicableWhen.reduce((score, condition) => {
        const conditionTokens = this.tokenize(condition);
        const overlap = this.calculateTextSimilarity(queryTokens, conditionTokens);
        return Math.max(score, overlap);
      }, 0);

      // Also check goal description similarity
      const descTokens = this.tokenize(exp.goalDescription);
      const descScore = this.calculateTextSimilarity(queryTokens, descTokens);

      const finalScore = Math.max(conditionScore, descScore);

      if (finalScore > 0.5) {
        relevant.push({ exp, score: finalScore });
      }
    }

    return relevant
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(r => r.exp);
  }

  private extractApplicableConditions(goalDescription: string): string[] {
    const conditions: string[] = [];

    // Extract key phrases
    const words = goalDescription.toLowerCase().split(/\s+/);

    // Look for action verbs
    const actionVerbs = ['book', 'find', 'search', 'create', 'update', 'delete', 'send', 'schedule', 'order'];
    for (const verb of actionVerbs) {
      if (words.includes(verb)) {
        conditions.push(`action:${verb}`);
      }
    }

    // Look for domain keywords
    const domains = ['flight', 'hotel', 'car', 'email', 'meeting', 'report', 'data', 'file'];
    for (const domain of domains) {
      if (goalDescription.toLowerCase().includes(domain)) {
        conditions.push(`domain:${domain}`);
      }
    }

    // Add the full goal as a condition
    conditions.push(goalDescription.substring(0, 100));

    return conditions;
  }

  private tokenize(text: string): string[] {
    // Simple tokenization - in production, use a proper NLP tokenizer
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .filter(t => !this.isStopWord(t));
  }

  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'this', 'that',
      'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what',
      'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'all',
      'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
    ]);
    return stopWords.has(word);
  }

  private calculateTextSimilarity(tokens1: string[], tokens2: string[]): number {
    if (tokens1.length === 0 || tokens2.length === 0) return 0;

    const set1 = new Set(tokens1);
    const set2 = new Set(tokens2);

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    // Jaccard similarity
    return intersection.size / union.size;
  }
}
