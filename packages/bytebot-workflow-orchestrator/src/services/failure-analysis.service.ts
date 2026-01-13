/**
 * Failure Analysis Service
 * Phase 9 (v5.4.0): Advanced AI Features
 *
 * Responsibilities:
 * - Analyze failed goal runs to identify root causes
 * - Cluster similar failures to detect patterns
 * - Generate remediation suggestions
 * - Predict potential failures before they occur
 * - Track failure trends over time
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { z } from 'zod';

// Zod schemas for LLM output validation
const RootCauseSchema = z.object({
  category: z.enum([
    'configuration',
    'network',
    'authentication',
    'timeout',
    'resource',
    'validation',
    'dependency',
    'user_input',
    'system',
    'unknown',
  ]),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).optional(),
});

const RemediationSchema = z.object({
  action: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  estimatedEffort: z.enum(['quick', 'moderate', 'significant']),
  reasoning: z.string().optional(),
});

const FailureAnalysisOutputSchema = z.object({
  rootCauses: z.array(RootCauseSchema).min(1),
  remediations: z.array(RemediationSchema),
  similarFailures: z.array(z.string()).optional(),
  preventionSuggestions: z.array(z.string()).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
});

type FailureAnalysisOutput = z.infer<typeof FailureAnalysisOutputSchema>;

// Failure categories for clustering
export enum FailureCategory {
  CONFIGURATION = 'configuration',
  NETWORK = 'network',
  AUTHENTICATION = 'authentication',
  TIMEOUT = 'timeout',
  RESOURCE = 'resource',
  VALIDATION = 'validation',
  DEPENDENCY = 'dependency',
  USER_INPUT = 'user_input',
  SYSTEM = 'system',
  UNKNOWN = 'unknown',
}

// Public interfaces
export interface FailureAnalysisRequest {
  tenantId: string;
  goalRunId: string;
  includeHistory?: boolean;
}

export interface FailureAnalysisResult {
  goalRunId: string;
  goal: string;
  failedAt: Date;
  rootCauses: Array<{
    category: FailureCategory;
    description: string;
    confidence: number;
    evidence?: string[];
  }>;
  remediations: Array<{
    action: string;
    priority: 'high' | 'medium' | 'low';
    estimatedEffort: 'quick' | 'moderate' | 'significant';
    reasoning?: string;
  }>;
  severity: 'critical' | 'high' | 'medium' | 'low';
  similarFailuresCount: number;
  preventionSuggestions: string[];
  analysisConfidence: number;
}

export interface FailurePattern {
  id: string;
  category: FailureCategory;
  pattern: string;
  occurrenceCount: number;
  firstSeen: Date;
  lastSeen: Date;
  affectedGoalRunIds: string[];
  commonRemediations: string[];
  resolutionRate: number;
}

export interface FailureTrend {
  period: string;
  totalFailures: number;
  byCategory: Record<FailureCategory, number>;
  topPatterns: Array<{ pattern: string; count: number }>;
  resolutionRate: number;
}

export interface PredictiveAnalysis {
  goalRunId: string;
  riskScore: number;
  potentialFailurePoints: Array<{
    step: number;
    description: string;
    riskLevel: 'high' | 'medium' | 'low';
    mitigationSuggestion?: string;
  }>;
  historicalSuccessRate: number;
}

@Injectable()
export class FailureAnalysisService {
  private readonly logger = new Logger(FailureAnalysisService.name);
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

    this.logger.log('FailureAnalysisService initialized');
  }

  /**
   * Analyze a specific failed goal run
   */
  async analyzeFailure(request: FailureAnalysisRequest): Promise<FailureAnalysisResult> {
    const { tenantId, goalRunId, includeHistory = true } = request;

    this.logger.log(`Analyzing failure for goal run ${goalRunId}`);

    // Fetch the failed goal run with context
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
        activityEvents: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!goalRun) {
      throw new Error(`Goal run ${goalRunId} not found`);
    }

    // Get similar historical failures if requested
    let historicalContext: any[] = [];
    if (includeHistory) {
      historicalContext = await this.getSimilarFailures(tenantId, goalRun.goal, goalRun.error || '');
    }

    // Build analysis prompt
    const prompt = this.buildAnalysisPrompt(goalRun, historicalContext);

    try {
      const response = await this.callLLM(prompt);
      const parsed = this.parseLLMResponse(response);
      const validated = FailureAnalysisOutputSchema.safeParse(parsed);

      let result: FailureAnalysisResult;

      if (validated.success) {
        result = this.transformToResult(goalRun, validated.data, historicalContext.length);
      } else {
        this.logger.warn(`LLM response validation failed: ${validated.error.message}`);
        result = this.generateFallbackAnalysis(goalRun);
      }

      // Store analysis result
      await this.storeAnalysisResult(goalRunId, result);

      // Emit event
      this.eventEmitter.emit('failure-analysis.completed', {
        tenantId,
        goalRunId,
        severity: result.severity,
        rootCauseCount: result.rootCauses.length,
      });

      return result;
    } catch (error: any) {
      this.logger.error(`Failure analysis failed: ${error.message}`);
      return this.generateFallbackAnalysis(goalRun);
    }
  }

  /**
   * Get failure patterns for a tenant
   */
  async getFailurePatterns(
    tenantId: string,
    options?: { days?: number; limit?: number },
  ): Promise<FailurePattern[]> {
    const days = options?.days || 30;
    const limit = options?.limit || 10;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch failed goal runs
    const failedRuns = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: 'FAILED',
        createdAt: { gte: since },
      },
      select: {
        id: true,
        goal: true,
        error: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Cluster failures by error similarity
    const patterns = this.clusterFailures(failedRuns);

    return patterns.slice(0, limit);
  }

  /**
   * Get failure trends over time
   */
  async getFailureTrends(
    tenantId: string,
    options?: { days?: number; granularity?: 'day' | 'week' | 'month' },
  ): Promise<FailureTrend[]> {
    const days = options?.days || 30;
    const granularity = options?.granularity || 'day';
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Fetch failed and completed goal runs
    const runs = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        createdAt: { gte: since },
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      select: {
        id: true,
        status: true,
        error: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group by period
    const trends = this.groupByPeriod(runs, granularity);

    return trends;
  }

  /**
   * Predictive analysis for a goal before execution
   */
  async predictFailureRisk(
    tenantId: string,
    goal: string,
    constraints?: Record<string, any>,
  ): Promise<PredictiveAnalysis> {
    // Find similar historical goals
    const similarGoals = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      select: {
        id: true,
        goal: true,
        status: true,
        error: true,
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
      take: 100,
    });

    // Calculate similarity and success rate
    const similar = similarGoals
      .map(g => ({
        ...g,
        similarity: this.calculateSimilarity(goal, g.goal),
      }))
      .filter(g => g.similarity > 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);

    const successCount = similar.filter(g => g.status === 'COMPLETED').length;
    const historicalSuccessRate = similar.length > 0 ? successCount / similar.length : 0.5;

    // Calculate risk score (inverse of success rate with adjustments)
    let riskScore = 1 - historicalSuccessRate;

    // Adjust for goal complexity
    const wordCount = goal.split(' ').length;
    if (wordCount > 50) riskScore += 0.1;
    if (wordCount < 5) riskScore += 0.15;

    // Check for high-risk keywords
    const highRiskKeywords = ['delete', 'remove', 'transfer', 'payment', 'password'];
    if (highRiskKeywords.some(k => goal.toLowerCase().includes(k))) {
      riskScore += 0.1;
    }

    riskScore = Math.min(1, Math.max(0, riskScore));

    // Identify potential failure points
    const failedSimilar = similar.filter(g => g.status === 'FAILED');
    const potentialFailurePoints: PredictiveAnalysis['potentialFailurePoints'] = [];

    // Analyze common failure steps
    const failureSteps = new Map<string, number>();
    for (const failed of failedSimilar) {
      const items = failed.planVersions?.[0]?.checklistItems || [];
      items.forEach((item: any, idx: number) => {
        if (item.status === 'FAILED') {
          const key = `${idx}:${item.description.substring(0, 50)}`;
          failureSteps.set(key, (failureSteps.get(key) || 0) + 1);
        }
      });
    }

    // Add top failure points
    const sortedSteps = [...failureSteps.entries()].sort((a, b) => b[1] - a[1]);
    for (const [step, count] of sortedSteps.slice(0, 3)) {
      const [idx, desc] = step.split(':');
      potentialFailurePoints.push({
        step: parseInt(idx) + 1,
        description: desc,
        riskLevel: count >= 3 ? 'high' : count >= 2 ? 'medium' : 'low',
        mitigationSuggestion: `This step has failed ${count} times in similar goals. Consider adding verification.`,
      });
    }

    return {
      goalRunId: '', // Not yet created
      riskScore: Math.round(riskScore * 100) / 100,
      potentialFailurePoints,
      historicalSuccessRate: Math.round(historicalSuccessRate * 100) / 100,
    };
  }

  /**
   * Get remediation suggestions for a failure category
   */
  async getRemediationSuggestions(
    category: FailureCategory,
  ): Promise<Array<{ action: string; successRate: number }>> {
    // Common remediations by category
    const commonRemediations: Record<FailureCategory, Array<{ action: string; successRate: number }>> = {
      [FailureCategory.CONFIGURATION]: [
        { action: 'Verify environment variables are set correctly', successRate: 0.85 },
        { action: 'Check configuration file syntax', successRate: 0.75 },
        { action: 'Ensure required dependencies are installed', successRate: 0.8 },
      ],
      [FailureCategory.NETWORK]: [
        { action: 'Check network connectivity to target host', successRate: 0.7 },
        { action: 'Verify firewall rules allow the connection', successRate: 0.65 },
        { action: 'Test with increased timeout values', successRate: 0.6 },
      ],
      [FailureCategory.AUTHENTICATION]: [
        { action: 'Verify credentials are valid and not expired', successRate: 0.9 },
        { action: 'Check API key permissions', successRate: 0.85 },
        { action: 'Ensure authentication tokens are refreshed', successRate: 0.75 },
      ],
      [FailureCategory.TIMEOUT]: [
        { action: 'Increase operation timeout', successRate: 0.7 },
        { action: 'Break operation into smaller chunks', successRate: 0.65 },
        { action: 'Check for resource bottlenecks', successRate: 0.6 },
      ],
      [FailureCategory.RESOURCE]: [
        { action: 'Check available disk space', successRate: 0.8 },
        { action: 'Verify memory limits are sufficient', successRate: 0.75 },
        { action: 'Review resource quotas', successRate: 0.7 },
      ],
      [FailureCategory.VALIDATION]: [
        { action: 'Verify input data format', successRate: 0.85 },
        { action: 'Check for required fields', successRate: 0.8 },
        { action: 'Validate data types match expected schema', successRate: 0.75 },
      ],
      [FailureCategory.DEPENDENCY]: [
        { action: 'Update dependencies to compatible versions', successRate: 0.7 },
        { action: 'Check dependency service health', successRate: 0.75 },
        { action: 'Verify dependency API compatibility', successRate: 0.65 },
      ],
      [FailureCategory.USER_INPUT]: [
        { action: 'Clarify goal requirements with user', successRate: 0.8 },
        { action: 'Add input validation before processing', successRate: 0.75 },
        { action: 'Provide better error messages for invalid input', successRate: 0.7 },
      ],
      [FailureCategory.SYSTEM]: [
        { action: 'Check system logs for errors', successRate: 0.6 },
        { action: 'Restart affected services', successRate: 0.55 },
        { action: 'Verify system resources are available', successRate: 0.65 },
      ],
      [FailureCategory.UNKNOWN]: [
        { action: 'Review detailed logs for more context', successRate: 0.5 },
        { action: 'Try breaking down the goal into smaller steps', successRate: 0.6 },
        { action: 'Contact support if issue persists', successRate: 0.4 },
      ],
    };

    return commonRemediations[category] || commonRemediations[FailureCategory.UNKNOWN];
  }

  // Private methods

  private async getSimilarFailures(
    tenantId: string,
    goal: string,
    error: string,
  ): Promise<any[]> {
    const recentFailures = await this.prisma.goalRun.findMany({
      where: {
        tenantId,
        status: 'FAILED',
      },
      select: {
        id: true,
        goal: true,
        error: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Find similar by goal or error
    return recentFailures.filter(f => {
      const goalSimilarity = this.calculateSimilarity(goal, f.goal);
      const errorSimilarity = error && f.error ? this.calculateSimilarity(error, f.error) : 0;
      return goalSimilarity > 0.5 || errorSimilarity > 0.6;
    });
  }

  private calculateSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

    const intersection = [...words1].filter(w => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return union > 0 ? intersection / union : 0;
  }

  private buildAnalysisPrompt(goalRun: any, historicalContext: any[]): string {
    const errorInfo = goalRun.error || 'No error message recorded';
    const activities = goalRun.activityEvents
      ?.filter((e: any) => e.severity === 'error' || e.eventType.includes('FAIL'))
      .map((e: any) => `[${e.eventType}] ${e.title}: ${e.description || ''}`)
      .join('\n') || 'No error events';

    const checklistItems = goalRun.planVersions?.[0]?.checklistItems || [];
    const failedSteps = checklistItems
      .filter((i: any) => i.status === 'FAILED')
      .map((i: any) => `Step ${i.order}: ${i.description}`)
      .join('\n') || 'No failed steps recorded';

    const historicalInfo = historicalContext.length > 0
      ? `\nSIMILAR HISTORICAL FAILURES (${historicalContext.length}):\n${
        historicalContext.slice(0, 3).map(f => `- ${f.error || f.goal.substring(0, 50)}`).join('\n')
      }`
      : '';

    return `Analyze this failed goal run and identify root causes:

GOAL: "${goalRun.goal}"

ERROR: ${errorInfo}

FAILED STEPS:
${failedSteps}

ERROR EVENTS:
${activities}
${historicalInfo}

TASK:
1. Identify likely root causes with confidence scores
2. Categorize into: configuration, network, authentication, timeout, resource, validation, dependency, user_input, system, or unknown
3. Suggest specific remediations with priority
4. Assess severity: critical, high, medium, or low
5. Suggest prevention strategies

OUTPUT FORMAT (JSON):
{
  "rootCauses": [
    {
      "category": "category_name",
      "description": "What went wrong",
      "confidence": 0.0-1.0,
      "evidence": ["evidence1", "evidence2"]
    }
  ],
  "remediations": [
    {
      "action": "What to do",
      "priority": "high|medium|low",
      "estimatedEffort": "quick|moderate|significant",
      "reasoning": "Why this will help"
    }
  ],
  "preventionSuggestions": ["suggestion1", "suggestion2"],
  "severity": "critical|high|medium|low"
}

Analyze the failure:`;
  }

  private async callLLM(prompt: string): Promise<string> {
    if (!this.llmApiKey) {
      this.logger.warn('No LLM API key configured, using heuristic analysis');
      return this.getHeuristicAnalysis(prompt);
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

  private transformToResult(
    goalRun: any,
    output: FailureAnalysisOutput,
    similarCount: number,
  ): FailureAnalysisResult {
    return {
      goalRunId: goalRun.id,
      goal: goalRun.goal,
      failedAt: goalRun.updatedAt,
      rootCauses: output.rootCauses.map(rc => ({
        category: rc.category as FailureCategory,
        description: rc.description,
        confidence: rc.confidence,
        evidence: rc.evidence,
      })),
      remediations: output.remediations,
      severity: output.severity,
      similarFailuresCount: similarCount,
      preventionSuggestions: output.preventionSuggestions || [],
      analysisConfidence: output.rootCauses.reduce((sum, rc) => sum + rc.confidence, 0) / output.rootCauses.length,
    };
  }

  private generateFallbackAnalysis(goalRun: any): FailureAnalysisResult {
    const error = goalRun.error?.toLowerCase() || '';

    // Heuristic categorization
    let category = FailureCategory.UNKNOWN;
    let description = 'Unable to determine specific root cause';

    if (error.includes('timeout') || error.includes('timed out')) {
      category = FailureCategory.TIMEOUT;
      description = 'Operation timed out before completion';
    } else if (error.includes('network') || error.includes('connection') || error.includes('econnrefused')) {
      category = FailureCategory.NETWORK;
      description = 'Network connectivity issue';
    } else if (error.includes('auth') || error.includes('permission') || error.includes('unauthorized')) {
      category = FailureCategory.AUTHENTICATION;
      description = 'Authentication or permission failure';
    } else if (error.includes('not found') || error.includes('missing')) {
      category = FailureCategory.CONFIGURATION;
      description = 'Required resource or configuration not found';
    } else if (error.includes('invalid') || error.includes('validation')) {
      category = FailureCategory.VALIDATION;
      description = 'Input validation failed';
    }

    return {
      goalRunId: goalRun.id,
      goal: goalRun.goal,
      failedAt: goalRun.updatedAt,
      rootCauses: [{
        category,
        description,
        confidence: 0.5,
      }],
      remediations: [{
        action: 'Review error logs for more details',
        priority: 'high',
        estimatedEffort: 'quick',
      }],
      severity: 'medium',
      similarFailuresCount: 0,
      preventionSuggestions: ['Add better error handling', 'Include more detailed logging'],
      analysisConfidence: 0.5,
    };
  }

  private clusterFailures(
    failures: Array<{ id: string; goal: string; error: string | null; createdAt: Date }>,
  ): FailurePattern[] {
    const patterns: FailurePattern[] = [];
    const processed = new Set<string>();

    for (const failure of failures) {
      if (processed.has(failure.id)) continue;

      const errorKey = failure.error?.substring(0, 100) || failure.goal.substring(0, 50);
      const cluster = failures.filter(f => {
        if (processed.has(f.id)) return false;
        const fKey = f.error?.substring(0, 100) || f.goal.substring(0, 50);
        return this.calculateSimilarity(errorKey, fKey) > 0.6;
      });

      if (cluster.length >= 2) {
        cluster.forEach(c => processed.add(c.id));

        const category = this.categorizeError(failure.error || failure.goal);

        patterns.push({
          id: `fp-${Date.now()}-${patterns.length}`,
          category,
          pattern: errorKey,
          occurrenceCount: cluster.length,
          firstSeen: cluster[cluster.length - 1].createdAt,
          lastSeen: cluster[0].createdAt,
          affectedGoalRunIds: cluster.map(c => c.id),
          commonRemediations: [],
          resolutionRate: 0,
        });
      }
    }

    patterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
    return patterns;
  }

  private categorizeError(text: string): FailureCategory {
    const lower = text.toLowerCase();

    if (lower.includes('timeout')) return FailureCategory.TIMEOUT;
    if (lower.includes('network') || lower.includes('connection')) return FailureCategory.NETWORK;
    if (lower.includes('auth') || lower.includes('permission')) return FailureCategory.AUTHENTICATION;
    if (lower.includes('config') || lower.includes('not found')) return FailureCategory.CONFIGURATION;
    if (lower.includes('valid') || lower.includes('format')) return FailureCategory.VALIDATION;
    if (lower.includes('depend') || lower.includes('require')) return FailureCategory.DEPENDENCY;
    if (lower.includes('resource') || lower.includes('memory') || lower.includes('disk')) return FailureCategory.RESOURCE;

    return FailureCategory.UNKNOWN;
  }

  private groupByPeriod(
    runs: Array<{ id: string; status: string; error: string | null; createdAt: Date }>,
    granularity: 'day' | 'week' | 'month',
  ): FailureTrend[] {
    const groups = new Map<string, typeof runs>();

    for (const run of runs) {
      const date = new Date(run.createdAt);
      let key: string;

      if (granularity === 'day') {
        key = date.toISOString().split('T')[0];
      } else if (granularity === 'week') {
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        key = `Week of ${weekStart.toISOString().split('T')[0]}`;
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(run);
    }

    const trends: FailureTrend[] = [];

    for (const [period, periodRuns] of groups) {
      const failures = periodRuns.filter(r => r.status === 'FAILED');
      const completed = periodRuns.filter(r => r.status === 'COMPLETED');

      const byCategory: Record<FailureCategory, number> = {} as any;
      for (const cat of Object.values(FailureCategory)) {
        byCategory[cat] = 0;
      }

      for (const failure of failures) {
        const cat = this.categorizeError(failure.error || '');
        byCategory[cat]++;
      }

      // Top patterns
      const patternCounts = new Map<string, number>();
      for (const failure of failures) {
        const pattern = (failure.error || 'Unknown').substring(0, 50);
        patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
      }

      const topPatterns = [...patternCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pattern, count]) => ({ pattern, count }));

      trends.push({
        period,
        totalFailures: failures.length,
        byCategory,
        topPatterns,
        resolutionRate: periodRuns.length > 0
          ? completed.length / periodRuns.length
          : 0,
      });
    }

    return trends;
  }

  private async storeAnalysisResult(goalRunId: string, result: FailureAnalysisResult): Promise<void> {
    try {
      await this.prisma.failureAnalysisResult.create({
        data: {
          goalRunId,
          primaryCategory: result.rootCauses[0]?.category || 'unknown',
          severity: result.severity,
          rootCauses: result.rootCauses as any,
          remediations: result.remediations as any,
          analysisConfidence: result.analysisConfidence,
        },
      });
    } catch (error: any) {
      this.logger.warn(`Failed to store analysis result: ${error.message}`);
    }
  }

  private getHeuristicAnalysis(prompt: string): string {
    // Extract error from prompt
    const errorMatch = prompt.match(/ERROR: (.+?)(?:\n|FAILED)/s);
    const error = errorMatch ? errorMatch[1].trim() : 'Unknown error';

    const category = this.categorizeError(error);

    return JSON.stringify({
      rootCauses: [{
        category,
        description: `Detected ${category} issue based on error pattern`,
        confidence: 0.6,
        evidence: [error.substring(0, 100)],
      }],
      remediations: [{
        action: 'Review the error message and check related configuration',
        priority: 'high',
        estimatedEffort: 'moderate',
        reasoning: 'Standard troubleshooting approach',
      }],
      preventionSuggestions: [
        'Add more detailed logging',
        'Implement retry logic for transient failures',
      ],
      severity: 'medium',
    });
  }
}
