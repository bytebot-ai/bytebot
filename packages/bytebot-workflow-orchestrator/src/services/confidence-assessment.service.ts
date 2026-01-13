/**
 * Confidence Assessment Service
 * v1.0.0: Nice-to-Have Enhancement for Autonomous Decision Making
 *
 * Implements multi-dimensional confidence scoring for AI agent decisions:
 * - Self-reported confidence from AI response analysis
 * - Task clarity assessment
 * - Context sufficiency evaluation
 * - Risk-based threshold adjustment
 *
 * Used by the orchestrator to determine when tasks can proceed autonomously
 * vs when human review is needed.
 *
 * @see /docs/CONTEXT_PROPAGATION_FIX_JAN_2026.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';

// Confidence dimensions for multi-factor assessment
export interface ConfidenceDimensions {
  taskClarity: number;         // How well-defined is the task? (0-1)
  contextSufficiency: number;  // Is there enough context? (0-1)
  domainFamiliarity: number;   // Is this a well-understood domain? (0-1)
  riskLevel: number;           // What's the potential impact of errors? (0-1)
  reversibility: number;       // Can the action be undone? (0-1)
}

// Composite confidence assessment result
export interface ConfidenceAssessment {
  overall: number;                                    // Combined score (0-1)
  dimensions: ConfidenceDimensions;                   // Individual dimension scores
  recommendation: 'proceed' | 'review' | 'escalate'; // Action recommendation
  reasoning: string;                                  // Explanation for the assessment
  thresholds: {
    autoApprove: number;
    review: number;
    escalate: number;
  };
}

// Task context for assessment
export interface TaskAssessmentContext {
  taskId?: string;
  goalRunId?: string;
  stepDescription: string;
  goalContext?: string;
  previousStepsCount: number;
  previousStepsSuccessRate: number;
  hasDesktopRequirement: boolean;
  estimatedImpact: 'low' | 'medium' | 'high' | 'critical';
  isReversible: boolean;
  retryCount: number;
}

// Confidence metrics for monitoring
export interface ConfidenceMetrics {
  totalAssessments: number;
  autoApproveRate: number;
  reviewRate: number;
  escalateRate: number;
  averageConfidence: number;
  calibrationError: number;     // How well confidence predicts success
}

// Threshold configuration
interface ThresholdConfig {
  autoApproveThreshold: number;
  reviewThreshold: number;
  escalateThreshold: number;
  impactAdjustments: Record<string, number>;
  categoryThresholds: Record<string, { autoApprove: number; review: number }>;
}

@Injectable()
export class ConfidenceAssessmentService {
  private readonly logger = new Logger(ConfidenceAssessmentService.name);

  // Default dimension weights for composite scoring
  private readonly dimensionWeights: ConfidenceDimensions = {
    taskClarity: 0.25,
    contextSufficiency: 0.25,
    domainFamiliarity: 0.20,
    riskLevel: 0.15,
    reversibility: 0.15,
  };

  // Threshold configuration (can be overridden via environment)
  private readonly thresholdConfig: ThresholdConfig;

  // Metrics tracking
  private metrics: {
    assessments: Array<{
      confidence: number;
      recommendation: string;
      timestamp: Date;
      outcome?: 'success' | 'failure';
    }>;
  } = { assessments: [] };

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // Load threshold configuration from environment
    this.thresholdConfig = {
      autoApproveThreshold: parseFloat(
        this.configService.get('CONFIDENCE_AUTO_APPROVE_THRESHOLD', '0.85'),
      ),
      reviewThreshold: parseFloat(
        this.configService.get('CONFIDENCE_REVIEW_THRESHOLD', '0.60'),
      ),
      escalateThreshold: parseFloat(
        this.configService.get('CONFIDENCE_ESCALATE_THRESHOLD', '0.40'),
      ),
      impactAdjustments: {
        low: -0.05,
        medium: 0,
        high: 0.05,
        critical: 0.10,
      },
      categoryThresholds: {
        browser_automation: { autoApprove: 0.80, review: 0.55 },
        data_entry: { autoApprove: 0.85, review: 0.60 },
        api_interaction: { autoApprove: 0.90, review: 0.70 },
        file_manipulation: { autoApprove: 0.88, review: 0.65 },
      },
    };

    this.logger.log(
      `Confidence thresholds: auto=${this.thresholdConfig.autoApproveThreshold}, ` +
      `review=${this.thresholdConfig.reviewThreshold}, ` +
      `escalate=${this.thresholdConfig.escalateThreshold}`,
    );
  }

  /**
   * Assess confidence for a task execution decision
   *
   * This is the main entry point for confidence scoring. It:
   * 1. Evaluates multiple confidence dimensions
   * 2. Calculates a composite score
   * 3. Applies risk-based threshold adjustments
   * 4. Returns a recommendation (proceed/review/escalate)
   */
  assessConfidence(context: TaskAssessmentContext): ConfidenceAssessment {
    // Calculate individual dimensions
    const dimensions = this.calculateDimensions(context);

    // Calculate composite confidence score
    const dimensionScore = this.calculateCompositeScore(dimensions);

    // Get effective thresholds (adjusted for risk)
    const thresholds = this.getEffectiveThresholds(context);

    // Make recommendation based on score and thresholds
    const recommendation = this.makeRecommendation(
      dimensionScore,
      thresholds,
      context,
    );

    // Generate reasoning
    const reasoning = this.generateReasoning(
      dimensionScore,
      dimensions,
      recommendation,
      context,
    );

    const assessment: ConfidenceAssessment = {
      overall: dimensionScore,
      dimensions,
      recommendation,
      reasoning,
      thresholds,
    };

    // Track for metrics
    this.recordAssessment(assessment);

    // Emit event for monitoring
    this.eventEmitter.emit('confidence.assessed', {
      taskId: context.taskId,
      goalRunId: context.goalRunId,
      confidence: dimensionScore,
      recommendation,
    });

    this.logger.debug(
      `Confidence assessment for step "${context.stepDescription.slice(0, 50)}...": ` +
      `${(dimensionScore * 100).toFixed(1)}% → ${recommendation}`,
    );

    return assessment;
  }

  /**
   * Record outcome for calibration (called when task completes)
   */
  recordOutcome(
    taskId: string,
    outcome: 'success' | 'failure',
  ): void {
    // Find recent assessment for this task and update outcome
    const recentAssessment = this.metrics.assessments.find(
      (a) => !a.outcome && Date.now() - a.timestamp.getTime() < 3600000, // 1 hour
    );

    if (recentAssessment) {
      recentAssessment.outcome = outcome;
    }

    this.logger.debug(`Recorded outcome for task ${taskId}: ${outcome}`);
  }

  /**
   * Get current confidence metrics for monitoring
   */
  getMetrics(): ConfidenceMetrics {
    const assessments = this.metrics.assessments;
    const total = assessments.length;

    if (total === 0) {
      return {
        totalAssessments: 0,
        autoApproveRate: 0,
        reviewRate: 0,
        escalateRate: 0,
        averageConfidence: 0,
        calibrationError: 0,
      };
    }

    const autoApproveCount = assessments.filter(
      (a) => a.recommendation === 'proceed',
    ).length;
    const reviewCount = assessments.filter(
      (a) => a.recommendation === 'review',
    ).length;
    const escalateCount = assessments.filter(
      (a) => a.recommendation === 'escalate',
    ).length;

    const avgConfidence = assessments.reduce(
      (sum, a) => sum + a.confidence, 0,
    ) / total;

    // Calculate calibration error (ECE) for assessments with outcomes
    const calibrationError = this.calculateCalibrationError();

    return {
      totalAssessments: total,
      autoApproveRate: autoApproveCount / total,
      reviewRate: reviewCount / total,
      escalateRate: escalateCount / total,
      averageConfidence: avgConfidence,
      calibrationError,
    };
  }

  /**
   * Update thresholds dynamically (for A/B testing or tuning)
   */
  updateThresholds(updates: Partial<ThresholdConfig>): void {
    Object.assign(this.thresholdConfig, updates);

    this.logger.log(
      `Updated confidence thresholds: auto=${this.thresholdConfig.autoApproveThreshold}, ` +
      `review=${this.thresholdConfig.reviewThreshold}`,
    );
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Calculate individual confidence dimensions
   */
  private calculateDimensions(context: TaskAssessmentContext): ConfidenceDimensions {
    return {
      taskClarity: this.assessTaskClarity(context),
      contextSufficiency: this.assessContextSufficiency(context),
      domainFamiliarity: this.assessDomainFamiliarity(context),
      riskLevel: this.assessRiskLevel(context),
      reversibility: context.isReversible ? 0.9 : 0.3,
    };
  }

  /**
   * Assess how clearly defined the task is
   */
  private assessTaskClarity(context: TaskAssessmentContext): number {
    let clarity = 0.5; // Base

    // Longer descriptions tend to be clearer
    const descLength = context.stepDescription.length;
    if (descLength > 100) clarity += 0.15;
    else if (descLength > 50) clarity += 0.10;

    // Having goal context improves clarity
    if (context.goalContext) clarity += 0.20;

    // Action verbs in description indicate clearer intent
    const actionVerbs = [
      'click', 'type', 'navigate', 'search', 'open', 'close',
      'submit', 'select', 'enter', 'fill', 'download', 'upload',
    ];
    const hasActionVerb = actionVerbs.some((verb) =>
      context.stepDescription.toLowerCase().includes(verb),
    );
    if (hasActionVerb) clarity += 0.10;

    return Math.min(clarity, 1);
  }

  /**
   * Assess if there's sufficient context
   */
  private assessContextSufficiency(context: TaskAssessmentContext): number {
    let sufficiency = 0.3; // Base

    // Goal context provides crucial information
    if (context.goalContext) {
      const contextLength = context.goalContext.length;
      if (contextLength > 200) sufficiency += 0.30;
      else if (contextLength > 100) sufficiency += 0.20;
      else sufficiency += 0.10;
    }

    // Previous steps provide continuity context
    if (context.previousStepsCount > 0) {
      const stepsBonus = Math.min(context.previousStepsCount * 0.05, 0.20);
      sufficiency += stepsBonus;

      // High success rate in previous steps indicates good context
      if (context.previousStepsSuccessRate > 0.8) {
        sufficiency += 0.15;
      }
    }

    return Math.min(sufficiency, 1);
  }

  /**
   * Assess domain familiarity (browser automation, APIs, etc.)
   */
  private assessDomainFamiliarity(context: TaskAssessmentContext): number {
    // Desktop/browser automation is well-understood
    if (context.hasDesktopRequirement) {
      return 0.75;
    }

    // Default for general tasks
    return 0.60;
  }

  /**
   * Assess risk level based on impact
   */
  private assessRiskLevel(context: TaskAssessmentContext): number {
    const impactRisk: Record<string, number> = {
      low: 0.20,
      medium: 0.50,
      high: 0.75,
      critical: 0.95,
    };

    let risk = impactRisk[context.estimatedImpact] || 0.50;

    // Retry attempts indicate potential issues
    if (context.retryCount > 0) {
      risk += Math.min(context.retryCount * 0.10, 0.20);
    }

    return Math.min(risk, 1);
  }

  /**
   * Calculate composite score from dimensions
   */
  private calculateCompositeScore(dimensions: ConfidenceDimensions): number {
    let score = 0;

    for (const [key, weight] of Object.entries(this.dimensionWeights)) {
      const dimensionValue = dimensions[key as keyof ConfidenceDimensions];
      score += dimensionValue * weight;
    }

    // Invert risk (high risk = lower confidence)
    // The riskLevel dimension is already weighted, but we apply an additional penalty
    const riskPenalty = dimensions.riskLevel * 0.15;
    score = Math.max(0, score - riskPenalty);

    return Math.min(Math.max(score, 0), 1);
  }

  /**
   * Get effective thresholds with risk adjustments
   */
  private getEffectiveThresholds(context: TaskAssessmentContext): {
    autoApprove: number;
    review: number;
    escalate: number;
  } {
    const { autoApproveThreshold, reviewThreshold, escalateThreshold, impactAdjustments } =
      this.thresholdConfig;

    // Apply impact-based adjustment
    const adjustment = impactAdjustments[context.estimatedImpact] || 0;

    // Apply retry penalty (stricter thresholds after failures)
    const retryPenalty = Math.min(context.retryCount * 0.05, 0.15);

    return {
      autoApprove: Math.min(autoApproveThreshold + adjustment + retryPenalty, 0.99),
      review: Math.min(reviewThreshold + adjustment + retryPenalty, autoApproveThreshold),
      escalate: escalateThreshold,
    };
  }

  /**
   * Make recommendation based on score and thresholds
   */
  private makeRecommendation(
    score: number,
    thresholds: { autoApprove: number; review: number; escalate: number },
    context: TaskAssessmentContext,
  ): 'proceed' | 'review' | 'escalate' {
    // Auto-approve: high confidence + (reversible OR very high confidence)
    if (score >= thresholds.autoApprove) {
      if (context.isReversible || score >= 0.95) {
        return 'proceed';
      }
      // High confidence but irreversible - still require review
      return 'review';
    }

    // Review: medium confidence
    if (score >= thresholds.review) {
      return 'review';
    }

    // Escalate: low confidence
    return 'escalate';
  }

  /**
   * Generate human-readable reasoning
   */
  private generateReasoning(
    score: number,
    dimensions: ConfidenceDimensions,
    recommendation: string,
    context: TaskAssessmentContext,
  ): string {
    const percentage = (score * 100).toFixed(1);

    // Identify low-scoring dimensions
    const lowDimensions = Object.entries(dimensions)
      .filter(([key, value]) => {
        // Risk is inverted (high = bad)
        if (key === 'riskLevel') return value > 0.6;
        return value < 0.5;
      })
      .map(([key]) => key.replace(/([A-Z])/g, ' $1').toLowerCase().trim());

    const parts: string[] = [`Confidence: ${percentage}%.`];

    if (lowDimensions.length > 0) {
      parts.push(`Concerns: ${lowDimensions.join(', ')}.`);
    }

    if (context.retryCount > 0) {
      parts.push(`Previous attempts: ${context.retryCount}.`);
    }

    parts.push(`Recommendation: ${recommendation}.`);

    return parts.join(' ');
  }

  /**
   * Record assessment for metrics tracking
   */
  private recordAssessment(assessment: ConfidenceAssessment): void {
    this.metrics.assessments.push({
      confidence: assessment.overall,
      recommendation: assessment.recommendation,
      timestamp: new Date(),
    });

    // Keep only last 1000 assessments
    if (this.metrics.assessments.length > 1000) {
      this.metrics.assessments = this.metrics.assessments.slice(-1000);
    }
  }

  /**
   * Calculate Expected Calibration Error (ECE)
   * Measures how well confidence predictions match actual outcomes
   */
  private calculateCalibrationError(): number {
    const withOutcomes = this.metrics.assessments.filter((a) => a.outcome);
    if (withOutcomes.length < 10) return 0; // Not enough data

    // Group into bins
    const bins: Array<{ confidence: number; success: boolean }[]> = [
      [], [], [], [], [], [], [], [], [], [],
    ];

    for (const assessment of withOutcomes) {
      const binIndex = Math.min(Math.floor(assessment.confidence * 10), 9);
      bins[binIndex].push({
        confidence: assessment.confidence,
        success: assessment.outcome === 'success',
      });
    }

    // Calculate ECE
    let totalError = 0;
    let totalCount = 0;

    for (const bin of bins) {
      if (bin.length === 0) continue;

      const avgConfidence = bin.reduce((s, a) => s + a.confidence, 0) / bin.length;
      const actualSuccessRate = bin.filter((a) => a.success).length / bin.length;

      totalError += bin.length * Math.abs(avgConfidence - actualSuccessRate);
      totalCount += bin.length;
    }

    return totalCount > 0 ? totalError / totalCount : 0;
  }
}
