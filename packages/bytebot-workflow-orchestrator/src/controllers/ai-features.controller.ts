/**
 * AI Features Controller
 * Phase 9 (v5.4.0): Advanced AI Features
 *
 * REST API endpoints for AI-powered features:
 * - Goal refinement and analysis
 * - Automatic template generation
 * - Failure pattern analysis and predictions
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
  ApiProperty,
} from '@nestjs/swagger';
import {
  GoalRefinementService,
  RefinementRequest,
  RefinementResult,
  QuickAnalysisResult,
} from '../services/goal-refinement.service';
import {
  TemplateGenerationService,
  TemplateGenerationRequest,
  TemplateGenerationResult,
  TemplateCandidate,
} from '../services/template-generation.service';
import {
  FailureAnalysisService,
  FailureCategory,
  FailureAnalysisResult,
  FailurePattern,
  FailureTrend,
  PredictiveAnalysis,
} from '../services/failure-analysis.service';

// ============================================================================
// Goal Refinement DTOs
// ============================================================================

class RefineGoalContextDto {
  @ApiProperty({ required: false, type: [String], description: 'Previous goals by the user' })
  previousGoals?: string[];

  @ApiProperty({ required: false, description: 'User preferences' })
  userPreferences?: Record<string, any>;

  @ApiProperty({ required: false, description: 'Domain context (e.g., web-automation, data-processing)' })
  domain?: string;
}

class RefineGoalOptionsDto {
  @ApiProperty({ required: false, description: 'Maximum number of suggestions to generate', default: 3 })
  maxSuggestions?: number;

  @ApiProperty({ required: false, description: 'Include clarifying questions', default: true })
  includeQuestions?: boolean;

  @ApiProperty({ required: false, description: 'Include goal decomposition', default: true })
  includeDecomposition?: boolean;

  @ApiProperty({ required: false, enum: ['concise', 'detailed', 'technical'], description: 'Response style' })
  style?: 'concise' | 'detailed' | 'technical';
}

class RefineGoalDto {
  @ApiProperty({ description: 'The goal text to refine', minLength: 5 })
  goal: string;

  @ApiProperty({ required: false, type: RefineGoalContextDto })
  context?: RefineGoalContextDto;

  @ApiProperty({ required: false, type: RefineGoalOptionsDto })
  options?: RefineGoalOptionsDto;
}

class QuickAnalyzeDto {
  @ApiProperty({ description: 'The goal text to quickly analyze' })
  goal: string;
}

class DecomposeGoalDto {
  @ApiProperty({ description: 'The goal to decompose into sub-goals' })
  goal: string;

  @ApiProperty({ required: false, description: 'Maximum number of sub-goals', default: 5 })
  maxSubGoals?: number;
}

class HistorySuggestionsDto {
  @ApiProperty({ description: 'Partial goal text to find similar goals' })
  partialGoal: string;

  @ApiProperty({ required: false, description: 'Maximum suggestions', default: 5 })
  limit?: number;
}

// ============================================================================
// Template Generation DTOs
// ============================================================================

class GenerateTemplatesOptionsDto {
  @ApiProperty({ required: false, description: 'Minimum goals required for pattern detection', default: 3 })
  minGoalsForPattern?: number;

  @ApiProperty({ required: false, description: 'Similarity threshold (0-1)', default: 0.6 })
  similarityThreshold?: number;

  @ApiProperty({ required: false, description: 'Maximum templates to generate', default: 10 })
  maxTemplates?: number;

  @ApiProperty({ required: false, description: 'Include checklist templates', default: true })
  includeChecklist?: boolean;
}

class SuggestVariablesDto {
  @ApiProperty({ description: 'The goal text to analyze for variables' })
  goal: string;
}

// ============================================================================
// Failure Analysis DTOs
// ============================================================================

class AnalyzeFailureDto {
  @ApiProperty({ description: 'Goal run ID to analyze' })
  goalRunId: string;

  @ApiProperty({ required: false, description: 'Include historical context', default: true })
  includeHistory?: boolean;
}

class PredictFailureDto {
  @ApiProperty({ description: 'The goal to predict failure risk for' })
  goal: string;

  @ApiProperty({ required: false, description: 'Constraints for the goal execution' })
  constraints?: Record<string, any>;
}

class FailurePatternsQueryDto {
  @ApiProperty({ required: false, description: 'Number of days to analyze', default: '30' })
  days?: string;

  @ApiProperty({ required: false, description: 'Maximum patterns to return', default: '10' })
  limit?: string;
}

class FailureTrendsQueryDto {
  @ApiProperty({ required: false, description: 'Number of days to analyze', default: '30' })
  days?: string;

  @ApiProperty({ required: false, enum: ['day', 'week', 'month'], description: 'Trend granularity' })
  granularity?: 'day' | 'week' | 'month';
}

// ============================================================================
// AI Features Controller
// ============================================================================

@ApiTags('ai-features')
@Controller('ai')
export class AiFeaturesController {
  constructor(
    private goalRefinementService: GoalRefinementService,
    private templateGenerationService: TemplateGenerationService,
    private failureAnalysisService: FailureAnalysisService,
  ) {}

  // ==========================================================================
  // Goal Refinement Endpoints
  // ==========================================================================

  /**
   * POST /api/v1/ai/refinement/refine
   * Analyze and refine a goal using AI
   * Rate limited: 10 per minute (LLM operation)
   */
  @Post('refinement/refine')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Refine a goal',
    description: 'Uses AI to analyze a goal and generate refined SMART goal suggestions with clarifying questions.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Goal refined successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async refineGoal(
    @Body() dto: RefineGoalDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: RefinementResult }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.goal || dto.goal.trim().length < 5) {
      throw new BadRequestException('Goal must be at least 5 characters');
    }

    const request: RefinementRequest = {
      tenantId,
      goal: dto.goal.trim(),
      context: dto.context,
      options: dto.options,
    };

    const result = await this.goalRefinementService.refineGoal(request);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/refinement/quick-analyze
   * Quick heuristic analysis without LLM call
   */
  @Post('refinement/quick-analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Quick goal analysis',
    description: 'Fast heuristic-based analysis without calling the LLM. Returns clarity, specificity, and actionability scores.',
  })
  @ApiResponse({ status: 200, description: 'Analysis completed' })
  async quickAnalyze(
    @Body() dto: QuickAnalyzeDto,
  ): Promise<{ success: boolean; data: QuickAnalysisResult }> {
    if (!dto.goal || dto.goal.trim().length < 3) {
      throw new BadRequestException('Goal must be at least 3 characters');
    }

    const result = await this.goalRefinementService.quickAnalyze(dto.goal.trim());

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/refinement/decompose
   * Decompose a complex goal into sub-goals
   */
  @Post('refinement/decompose')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Decompose goal into sub-goals',
    description: 'Breaks down a complex goal into smaller, actionable sub-goals using AI.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Goal decomposed successfully' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async decomposeGoal(
    @Body() dto: DecomposeGoalDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: Array<{ subGoal: string; order: number; estimatedDuration?: string }> }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.goal || dto.goal.trim().length < 5) {
      throw new BadRequestException('Goal must be at least 5 characters');
    }

    const result = await this.goalRefinementService.decomposeGoal(
      tenantId,
      dto.goal.trim(),
      dto.maxSubGoals || 5,
    );

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/refinement/history-suggestions
   * Get suggestions from historical successful goals
   */
  @Post('refinement/history-suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get suggestions from history',
    description: 'Returns similar successful goals from history based on partial input.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Suggestions retrieved' })
  async getHistorySuggestions(
    @Body() dto: HistorySuggestionsDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: Array<{ goal: string; similarity: number; usageCount: number }> }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.partialGoal || dto.partialGoal.trim().length < 3) {
      throw new BadRequestException('Partial goal must be at least 3 characters');
    }

    const result = await this.goalRefinementService.getSuggestionsFromHistory(
      tenantId,
      dto.partialGoal.trim(),
      dto.limit || 5,
    );

    return {
      success: true,
      data: result,
    };
  }

  // ==========================================================================
  // Template Generation Endpoints
  // ==========================================================================

  /**
   * POST /api/v1/ai/templates/generate
   * Generate templates from historical goals
   * Rate limited: 5 per minute (expensive operation)
   */
  @Post('templates/generate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Generate templates from history',
    description: 'Analyzes completed goals to automatically generate reusable templates. Identifies patterns and extracts variables.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Templates generated successfully' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async generateTemplates(
    @Body() dto: GenerateTemplatesOptionsDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: TemplateGenerationResult }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const request: TemplateGenerationRequest = {
      tenantId,
      options: {
        minGoalsForPattern: dto.minGoalsForPattern,
        similarityThreshold: dto.similarityThreshold,
        maxTemplates: dto.maxTemplates,
        includeChecklist: dto.includeChecklist,
      },
    };

    const result = await this.templateGenerationService.generateTemplatesFromHistory(request);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/templates/from-goal/:goalRunId
   * Generate a template from a specific goal run
   */
  @Post('templates/from-goal/:goalRunId')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Generate template from goal run',
    description: 'Creates a reusable template from a specific completed goal run.',
  })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Template generated successfully' })
  @ApiResponse({ status: 404, description: 'Goal run not found' })
  async generateTemplateFromGoal(
    @Param('goalRunId') goalRunId: string,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: TemplateCandidate | null }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const result = await this.templateGenerationService.generateTemplateFromGoal(tenantId, goalRunId);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/templates/suggest-variables
   * Suggest variables for a goal pattern
   */
  @Post('templates/suggest-variables')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suggest variables for goal',
    description: 'Analyzes a goal and suggests variables that could be extracted for templating.',
  })
  @ApiResponse({ status: 200, description: 'Variables suggested' })
  async suggestVariables(
    @Body() dto: SuggestVariablesDto,
  ): Promise<{ success: boolean; data: Array<{ name: string; value: string; type: string; confidence: number }> }> {
    if (!dto.goal || dto.goal.trim().length < 5) {
      throw new BadRequestException('Goal must be at least 5 characters');
    }

    const result = await this.templateGenerationService.suggestVariables(dto.goal.trim());

    return {
      success: true,
      data: result,
    };
  }

  // ==========================================================================
  // Failure Analysis Endpoints
  // ==========================================================================

  /**
   * POST /api/v1/ai/failures/analyze
   * Analyze a specific failed goal run
   * Rate limited: 10 per minute (LLM operation)
   */
  @Post('failures/analyze')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Analyze failure',
    description: 'Uses AI to analyze a failed goal run, identify root causes, and suggest remediations.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Failure analyzed successfully' })
  @ApiResponse({ status: 404, description: 'Goal run not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async analyzeFailure(
    @Body() dto: AnalyzeFailureDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: FailureAnalysisResult }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.goalRunId) {
      throw new BadRequestException('goalRunId is required');
    }

    const result = await this.failureAnalysisService.analyzeFailure({
      tenantId,
      goalRunId: dto.goalRunId,
      includeHistory: dto.includeHistory,
    });

    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /api/v1/ai/failures/patterns
   * Get failure patterns for the tenant
   */
  @Get('failures/patterns')
  @ApiOperation({
    summary: 'Get failure patterns',
    description: 'Returns clustered failure patterns detected across goal runs.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiQuery({ name: 'days', required: false, description: 'Number of days to analyze' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum patterns to return' })
  @ApiResponse({ status: 200, description: 'Patterns retrieved' })
  async getFailurePatterns(
    @Query() query: FailurePatternsQueryDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: FailurePattern[] }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const result = await this.failureAnalysisService.getFailurePatterns(tenantId, {
      days: query.days ? parseInt(query.days, 10) : 30,
      limit: query.limit ? parseInt(query.limit, 10) : 10,
    });

    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /api/v1/ai/failures/trends
   * Get failure trends over time
   */
  @Get('failures/trends')
  @ApiOperation({
    summary: 'Get failure trends',
    description: 'Returns failure trends aggregated by time period.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiQuery({ name: 'days', required: false, description: 'Number of days to analyze' })
  @ApiQuery({ name: 'granularity', required: false, enum: ['day', 'week', 'month'] })
  @ApiResponse({ status: 200, description: 'Trends retrieved' })
  async getFailureTrends(
    @Query() query: FailureTrendsQueryDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: FailureTrend[] }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const result = await this.failureAnalysisService.getFailureTrends(tenantId, {
      days: query.days ? parseInt(query.days, 10) : 30,
      granularity: query.granularity,
    });

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/ai/failures/predict
   * Predict failure risk for a goal
   */
  @Post('failures/predict')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Predict failure risk',
    description: 'Analyzes historical data to predict potential failure points for a goal before execution.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Prediction completed' })
  async predictFailure(
    @Body() dto: PredictFailureDto,
    @Headers('x-tenant-id') tenantId?: string,
  ): Promise<{ success: boolean; data: PredictiveAnalysis }> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.goal || dto.goal.trim().length < 5) {
      throw new BadRequestException('Goal must be at least 5 characters');
    }

    const result = await this.failureAnalysisService.predictFailureRisk(
      tenantId,
      dto.goal.trim(),
      dto.constraints,
    );

    return {
      success: true,
      data: result,
    };
  }

  /**
   * GET /api/v1/ai/failures/remediations/:category
   * Get remediation suggestions for a failure category
   */
  @Get('failures/remediations/:category')
  @ApiOperation({
    summary: 'Get remediation suggestions',
    description: 'Returns common remediation actions for a specific failure category.',
  })
  @ApiParam({
    name: 'category',
    enum: Object.values(FailureCategory),
    description: 'Failure category',
  })
  @ApiResponse({ status: 200, description: 'Remediations retrieved' })
  async getRemediations(
    @Param('category') category: string,
  ): Promise<{ success: boolean; data: Array<{ action: string; successRate: number }> }> {
    if (!Object.values(FailureCategory).includes(category as FailureCategory)) {
      throw new BadRequestException(`Invalid category. Must be one of: ${Object.values(FailureCategory).join(', ')}`);
    }

    const result = await this.failureAnalysisService.getRemediationSuggestions(category as FailureCategory);

    return {
      success: true,
      data: result,
    };
  }

  // ==========================================================================
  // Utility Endpoints
  // ==========================================================================

  /**
   * GET /api/v1/ai/categories
   * Get available failure categories
   */
  @Get('categories')
  @ApiOperation({
    summary: 'Get failure categories',
    description: 'Returns all available failure categories for classification.',
  })
  @ApiResponse({ status: 200, description: 'Categories retrieved' })
  getFailureCategories(): { success: boolean; data: string[] } {
    return {
      success: true,
      data: Object.values(FailureCategory),
    };
  }
}
