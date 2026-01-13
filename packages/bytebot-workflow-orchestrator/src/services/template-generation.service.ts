/**
 * Template Generation Service
 * Phase 9 (v5.4.0): Advanced AI Features
 *
 * Responsibilities:
 * - Analyze completed goal runs to identify patterns
 * - Automatically generate reusable templates from similar goals
 * - Extract variables from goal patterns
 * - Score and rank template quality
 * - Suggest template improvements
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { TemplateVariable } from './goal-template.service';
import { z } from 'zod';

// Zod schemas for LLM output validation
const ExtractedVariableSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'select']),
  required: z.boolean(),
  description: z.string().optional(),
  exampleValues: z.array(z.union([z.string(), z.number()])).optional(),
  options: z.array(z.string()).optional(),
});

const GeneratedTemplateSchema = z.object({
  name: z.string(),
  description: z.string(),
  category: z.string().optional(),
  goalPattern: z.string(),
  variables: z.array(ExtractedVariableSchema),
  checklistTemplate: z.array(z.object({
    order: z.number(),
    descriptionTemplate: z.string(),
    expectedOutcomeTemplate: z.string().optional(),
  })).optional(),
  confidence: z.number().min(0).max(1),
  sourceGoalIds: z.array(z.string()).optional(),
});

type GeneratedTemplate = z.infer<typeof GeneratedTemplateSchema>;

// Public interfaces
export interface TemplateGenerationRequest {
  tenantId: string;
  options?: {
    minGoalsForPattern?: number;
    similarityThreshold?: number;
    maxTemplates?: number;
    includeChecklist?: boolean;
  };
}

export interface TemplateCandidate {
  name: string;
  description: string;
  category?: string;
  goalPattern: string;
  variables: TemplateVariable[];
  checklistTemplate?: Array<{
    order: number;
    descriptionTemplate: string;
    expectedOutcomeTemplate?: string;
  }>;
  confidence: number;
  sourceGoalCount: number;
  sourceGoalIds: string[];
  estimatedUsage: number;
  qualityScore: number;
}

export interface TemplateGenerationResult {
  candidates: TemplateCandidate[];
  analyzedGoalsCount: number;
  patternsFound: number;
  processingTimeMs: number;
}

export interface GoalCluster {
  representative: string;
  goals: Array<{ id: string; goal: string; createdAt: Date }>;
  similarity: number;
}

@Injectable()
export class TemplateGenerationService {
  private readonly logger = new Logger(TemplateGenerationService.name);
  private readonly llmModel: string;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');

    this.logger.log('TemplateGenerationService initialized');
  }

  /**
   * Analyze completed goals and generate template candidates
   */
  async generateTemplatesFromHistory(
    request: TemplateGenerationRequest,
  ): Promise<TemplateGenerationResult> {
    const startTime = Date.now();
    const { tenantId, options } = request;

    const minGoals = options?.minGoalsForPattern || 3;
    const similarityThreshold = options?.similarityThreshold || 0.6;
    const maxTemplates = options?.maxTemplates || 10;

    this.logger.log(`Generating templates for tenant ${tenantId}`);

    // Fetch completed goal runs
    const completedGoals = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        goal: true,
        createdAt: true,
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
      orderBy: { createdAt: 'desc' },
      take: 500, // Analyze last 500 completed goals
    });

    if (completedGoals.length < minGoals) {
      return {
        candidates: [],
        analyzedGoalsCount: completedGoals.length,
        patternsFound: 0,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // Cluster similar goals
    const clusters = this.clusterSimilarGoals(
      completedGoals.map(g => ({ id: g.id, goal: g.goal, createdAt: g.createdAt })),
      similarityThreshold,
    );

    // Filter clusters with enough goals
    const significantClusters = clusters.filter(c => c.goals.length >= minGoals);

    this.logger.log(`Found ${significantClusters.length} significant clusters from ${completedGoals.length} goals`);

    // Generate templates from clusters
    const candidates: TemplateCandidate[] = [];

    for (const cluster of significantClusters.slice(0, maxTemplates)) {
      try {
        const template = await this.generateTemplateFromCluster(
          cluster,
          completedGoals,
          options?.includeChecklist !== false,
        );

        if (template) {
          candidates.push(template);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to generate template from cluster: ${error.message}`);
      }
    }

    // Sort by quality score
    candidates.sort((a, b) => b.qualityScore - a.qualityScore);

    // Emit event
    this.eventEmitter.emit('template-generation.completed', {
      tenantId,
      candidatesCount: candidates.length,
      analyzedGoals: completedGoals.length,
    });

    return {
      candidates: candidates.slice(0, maxTemplates),
      analyzedGoalsCount: completedGoals.length,
      patternsFound: significantClusters.length,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Generate a template from a single goal
   */
  async generateTemplateFromGoal(
    tenantId: string,
    goalRunId: string,
  ): Promise<TemplateCandidate | null> {
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
      return null;
    }

    const prompt = this.buildSingleGoalTemplatePrompt(
      goalRun.goal,
      goalRun.planVersions[0]?.checklistItems || [],
    );

    try {
      const response = await this.callLLM(prompt);
      const parsed = this.parseLLMResponse(response);
      const validated = GeneratedTemplateSchema.safeParse(parsed);

      if (validated.success) {
        return this.transformToCandidate(validated.data, [goalRunId]);
      }

      return this.generateFallbackTemplate(goalRun.goal, goalRunId);
    } catch (error: any) {
      this.logger.error(`Single goal template generation failed: ${error.message}`);
      return this.generateFallbackTemplate(goalRun.goal, goalRunId);
    }
  }

  /**
   * Analyze a goal and suggest variable extraction
   */
  async suggestVariables(goal: string): Promise<Array<{
    name: string;
    value: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    confidence: number;
  }>> {
    const suggestions: Array<{
      name: string;
      value: string;
      type: 'string' | 'number' | 'boolean' | 'select';
      confidence: number;
    }> = [];

    // Extract URLs
    const urlMatch = goal.match(/https?:\/\/[^\s]+/g);
    if (urlMatch) {
      suggestions.push({
        name: 'url',
        value: urlMatch[0],
        type: 'string',
        confidence: 0.95,
      });
    }

    // Extract email addresses
    const emailMatch = goal.match(/[\w.-]+@[\w.-]+\.\w+/g);
    if (emailMatch) {
      suggestions.push({
        name: 'email',
        value: emailMatch[0],
        type: 'string',
        confidence: 0.95,
      });
    }

    // Extract numbers
    const numberMatch = goal.match(/\b\d+\b/g);
    if (numberMatch) {
      numberMatch.forEach((num, idx) => {
        suggestions.push({
          name: idx === 0 ? 'count' : `count${idx + 1}`,
          value: num,
          type: 'number',
          confidence: 0.8,
        });
      });
    }

    // Extract dates
    const datePatterns = [
      /\d{4}-\d{2}-\d{2}/,
      /\d{1,2}\/\d{1,2}\/\d{2,4}/,
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}/i,
    ];
    for (const pattern of datePatterns) {
      const match = goal.match(pattern);
      if (match) {
        suggestions.push({
          name: 'date',
          value: match[0],
          type: 'string',
          confidence: 0.9,
        });
        break;
      }
    }

    // Extract file paths
    const pathMatch = goal.match(/(?:\/[\w.-]+)+\/?|(?:[A-Z]:)?\\(?:[\w.-]+\\)+[\w.-]*/g);
    if (pathMatch) {
      suggestions.push({
        name: 'filePath',
        value: pathMatch[0],
        type: 'string',
        confidence: 0.85,
      });
    }

    // Extract quoted strings
    const quotedMatch = goal.match(/"([^"]+)"|'([^']+)'/g);
    if (quotedMatch) {
      quotedMatch.forEach((quoted, idx) => {
        const value = quoted.replace(/['"]/g, '');
        suggestions.push({
          name: idx === 0 ? 'text' : `text${idx + 1}`,
          value,
          type: 'string',
          confidence: 0.75,
        });
      });
    }

    return suggestions;
  }

  /**
   * Get template quality score
   */
  calculateTemplateQuality(template: Partial<TemplateCandidate>): number {
    let score = 0;

    // Variable count (2-5 is ideal)
    const varCount = template.variables?.length || 0;
    if (varCount >= 2 && varCount <= 5) {
      score += 0.25;
    } else if (varCount === 1 || varCount === 6) {
      score += 0.15;
    } else if (varCount > 0) {
      score += 0.1;
    }

    // Has description
    if (template.description && template.description.length > 20) {
      score += 0.15;
    }

    // Has category
    if (template.category) {
      score += 0.1;
    }

    // Goal pattern length (50-200 chars is good)
    const patternLen = template.goalPattern?.length || 0;
    if (patternLen >= 50 && patternLen <= 200) {
      score += 0.2;
    } else if (patternLen >= 30) {
      score += 0.1;
    }

    // Has checklist template
    if (template.checklistTemplate && template.checklistTemplate.length > 0) {
      score += 0.2;
    }

    // Source goal count (more sources = more validated)
    const sourceCount = template.sourceGoalCount || 1;
    if (sourceCount >= 5) {
      score += 0.1;
    } else if (sourceCount >= 3) {
      score += 0.05;
    }

    return Math.round(score * 100) / 100;
  }

  // Private methods

  private clusterSimilarGoals(
    goals: Array<{ id: string; goal: string; createdAt: Date }>,
    threshold: number,
  ): GoalCluster[] {
    const clusters: GoalCluster[] = [];
    const assigned = new Set<string>();

    for (const goal of goals) {
      if (assigned.has(goal.id)) continue;

      const cluster: GoalCluster = {
        representative: goal.goal,
        goals: [goal],
        similarity: 1,
      };

      // Find similar goals
      for (const other of goals) {
        if (other.id === goal.id || assigned.has(other.id)) continue;

        const similarity = this.calculateSimilarity(goal.goal, other.goal);
        if (similarity >= threshold) {
          cluster.goals.push(other);
          cluster.similarity = Math.min(cluster.similarity, similarity);
          assigned.add(other.id);
        }
      }

      if (cluster.goals.length > 1) {
        assigned.add(goal.id);
        clusters.push(cluster);
      }
    }

    // Sort by cluster size
    clusters.sort((a, b) => b.goals.length - a.goals.length);

    return clusters;
  }

  private calculateSimilarity(goal1: string, goal2: string): number {
    const words1 = new Set(goal1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(goal2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    if (union === 0) return 0;

    // Jaccard similarity
    const jaccard = intersection / union;

    // Also consider structural similarity (same length range)
    const lenRatio = Math.min(goal1.length, goal2.length) / Math.max(goal1.length, goal2.length);

    return (jaccard * 0.7 + lenRatio * 0.3);
  }

  private async generateTemplateFromCluster(
    cluster: GoalCluster,
    allGoals: any[],
    includeChecklist: boolean,
  ): Promise<TemplateCandidate | null> {
    const goalTexts = cluster.goals.map(g => g.goal);
    const goalIds = cluster.goals.map(g => g.id);

    // Get checklist items for the cluster
    const checklistItems: any[] = [];
    if (includeChecklist) {
      const goalData = allGoals.filter(g => goalIds.includes(g.id));
      for (const g of goalData.slice(0, 3)) {
        if (g.planVersions?.[0]?.checklistItems) {
          checklistItems.push(...g.planVersions[0].checklistItems);
        }
      }
    }

    const prompt = this.buildClusterTemplatePrompt(goalTexts, checklistItems);

    try {
      const response = await this.callLLM(prompt);
      const parsed = this.parseLLMResponse(response);
      const validated = GeneratedTemplateSchema.safeParse(parsed);

      if (validated.success) {
        const candidate = this.transformToCandidate(validated.data, goalIds);
        candidate.sourceGoalCount = cluster.goals.length;
        return candidate;
      }

      return null;
    } catch (error: any) {
      this.logger.warn(`Cluster template generation failed: ${error.message}`);
      return null;
    }
  }

  private buildClusterTemplatePrompt(goals: string[], checklistItems: any[]): string {
    const goalsText = goals.slice(0, 10).map((g, i) => `${i + 1}. ${g}`).join('\n');

    const checklistText = checklistItems.length > 0
      ? `\nEXAMPLE CHECKLIST ITEMS:\n${checklistItems.slice(0, 5).map(c => `- ${c.description}`).join('\n')}`
      : '';

    return `Analyze these similar goals and generate a reusable template:

SIMILAR GOALS:
${goalsText}
${checklistText}

TASK:
1. Identify the common pattern across these goals
2. Extract variable parts that differ between goals
3. Create a template with {{variable}} placeholders
4. Suggest variable types and descriptions

OUTPUT FORMAT (JSON):
{
  "name": "Short descriptive name for template",
  "description": "What this template does",
  "category": "category name",
  "goalPattern": "Template with {{variable}} placeholders",
  "variables": [
    {
      "name": "variableName",
      "type": "string|number|boolean|select",
      "required": true,
      "description": "What this variable represents",
      "exampleValues": ["example1", "example2"]
    }
  ],
  "checklistTemplate": [
    {
      "order": 1,
      "descriptionTemplate": "Step with {{variable}}",
      "expectedOutcomeTemplate": "Expected result"
    }
  ],
  "confidence": 0.0-1.0
}

Generate the template:`;
  }

  private buildSingleGoalTemplatePrompt(goal: string, checklistItems: any[]): string {
    const checklistText = checklistItems.length > 0
      ? `\nCHECKLIST ITEMS:\n${checklistItems.map(c => `- ${c.description}`).join('\n')}`
      : '';

    return `Convert this specific goal into a reusable template:

GOAL: "${goal}"
${checklistText}

TASK:
1. Identify parts that could be parameterized
2. Create a template with {{variable}} placeholders
3. Define variable types

OUTPUT FORMAT (JSON):
{
  "name": "Short template name",
  "description": "Template description",
  "category": "category",
  "goalPattern": "Template with {{variables}}",
  "variables": [
    {
      "name": "var",
      "type": "string",
      "required": true,
      "description": "description"
    }
  ],
  "checklistTemplate": [],
  "confidence": 0.0-1.0
}

Generate the template:`;
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

  private transformToCandidate(
    generated: GeneratedTemplate,
    sourceGoalIds: string[],
  ): TemplateCandidate {
    const candidate: TemplateCandidate = {
      name: generated.name,
      description: generated.description,
      category: generated.category,
      goalPattern: generated.goalPattern,
      variables: generated.variables.map(v => ({
        name: v.name,
        type: v.type,
        required: v.required,
        description: v.description,
        options: v.options,
      })),
      checklistTemplate: generated.checklistTemplate,
      confidence: generated.confidence,
      sourceGoalCount: sourceGoalIds.length,
      sourceGoalIds,
      estimatedUsage: sourceGoalIds.length * 2, // Estimate based on pattern frequency
      qualityScore: 0,
    };

    candidate.qualityScore = this.calculateTemplateQuality(candidate);

    return candidate;
  }

  private generateFallbackTemplate(goal: string, goalId: string): TemplateCandidate {
    // Simple variable extraction
    const variables: TemplateVariable[] = [];
    let pattern = goal;

    // Extract URLs
    const urlMatch = goal.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      variables.push({ name: 'url', type: 'string', required: true, description: 'Target URL' });
      pattern = pattern.replace(urlMatch[0], '{{url}}');
    }

    // Extract numbers
    const numMatch = goal.match(/\b\d+\b/);
    if (numMatch) {
      variables.push({ name: 'count', type: 'number', required: true, description: 'Count value' });
      pattern = pattern.replace(numMatch[0], '{{count}}');
    }

    return {
      name: `Template from: ${goal.substring(0, 30)}...`,
      description: 'Auto-generated template',
      goalPattern: pattern,
      variables,
      confidence: 0.5,
      sourceGoalCount: 1,
      sourceGoalIds: [goalId],
      estimatedUsage: 1,
      qualityScore: 0.3,
    };
  }

  private getMockLLMResponse(prompt: string): string {
    return JSON.stringify({
      name: 'Sample Generated Template',
      description: 'A template generated from similar goals',
      category: 'general',
      goalPattern: 'Perform {{action}} on {{target}} with {{options}}',
      variables: [
        { name: 'action', type: 'string', required: true, description: 'The action to perform' },
        { name: 'target', type: 'string', required: true, description: 'The target of the action' },
        { name: 'options', type: 'string', required: false, description: 'Additional options' },
      ],
      checklistTemplate: [
        { order: 1, descriptionTemplate: 'Prepare {{target}}', expectedOutcomeTemplate: 'Target ready' },
        { order: 2, descriptionTemplate: 'Execute {{action}}', expectedOutcomeTemplate: 'Action completed' },
      ],
      confidence: 0.75,
    });
  }
}
