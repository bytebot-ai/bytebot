/**
 * Checkpoint Controller
 * v1.0.0: Checkpoint Visualization and Management API
 *
 * Provides REST endpoints for checkpoint inspection and management:
 * - View current checkpoint state
 * - Access checkpoint history
 * - Visualize progress and knowledge
 * - Trigger manual recovery
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS.md
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { GoalCheckpointService } from '../services/goal-checkpoint.service';
import { CheckpointPersistenceService } from '../services/checkpoint-persistence.service';
import { KnowledgeExtractionService } from '../services/knowledge-extraction.service';
import { ContextSummarizationService } from '../services/context-summarization.service';
import { BackgroundModeService } from '../services/background-mode.service';

@ApiTags('Checkpoints')
@Controller('checkpoints')
export class CheckpointController {
  private readonly logger = new Logger(CheckpointController.name);

  constructor(
    private readonly checkpointService: GoalCheckpointService,
    private readonly persistenceService: CheckpointPersistenceService,
    private readonly knowledgeService: KnowledgeExtractionService,
    private readonly contextService: ContextSummarizationService,
    private readonly backgroundService: BackgroundModeService,
  ) {}

  /**
   * Get checkpoint for a goal run
   */
  @Get(':goalRunId')
  @ApiOperation({ summary: 'Get checkpoint for a goal run' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Checkpoint retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Checkpoint not found' })
  async getCheckpoint(@Param('goalRunId') goalRunId: string) {
    const checkpoint = await this.checkpointService.getCheckpoint(goalRunId);

    if (!checkpoint) {
      throw new HttpException('Checkpoint not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      data: checkpoint,
    };
  }

  /**
   * Get checkpoint formatted for UI visualization
   */
  @Get(':goalRunId/visualization')
  @ApiOperation({ summary: 'Get checkpoint formatted for UI visualization' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Visualization data retrieved' })
  async getVisualization(@Param('goalRunId') goalRunId: string) {
    const checkpoint = await this.checkpointService.getCheckpoint(goalRunId);
    const knowledge = this.knowledgeService.getKnowledge(goalRunId);

    if (!checkpoint) {
      throw new HttpException('Checkpoint not found', HttpStatus.NOT_FOUND);
    }

    // Format for visualization
    const visualization = {
      // Progress ring data
      progress: {
        percentComplete: checkpoint.progressSummary.percentComplete,
        completedSteps: checkpoint.progressSummary.completedSteps,
        totalSteps: checkpoint.progressSummary.totalSteps,
        failedSteps: checkpoint.progressSummary.failedSteps,
        pendingSteps: checkpoint.progressSummary.pendingSteps,
      },

      // Timeline data
      timeline: [
        ...checkpoint.completedWork.map((work, index) => ({
          id: `step-${work.stepNumber}`,
          order: work.stepNumber,
          label: work.description,
          status: 'completed' as const,
          outcome: work.outcome as string | null,
          timestamp: work.completedAt as Date | null,
          duration: this.calculateDuration(checkpoint.completedWork, index),
        })),
        ...checkpoint.remainingSteps.map(step => ({
          id: `step-${step.stepNumber}`,
          order: step.stepNumber,
          label: step.description,
          status: step.status,
          outcome: null as string | null,
          timestamp: null as Date | null,
          duration: null as number | null,
        })),
      ].sort((a, b) => a.order - b.order),

      // Knowledge graph summary
      knowledge: knowledge ? {
        factCount: knowledge.facts.length,
        entityCount: knowledge.entities.length,
        decisionCount: knowledge.decisions.length,
        keyMetrics: knowledge.keyMetrics,
        recentFacts: knowledge.facts.slice(-5).map(f => ({
          type: f.type,
          content: f.content,
          confidence: f.confidence,
        })),
        topEntities: knowledge.entities
          .sort((a, b) => b.mentions - a.mentions)
          .slice(0, 5)
          .map(e => ({
            name: e.name,
            type: e.type,
            mentions: e.mentions,
          })),
      } : null,

      // Context info
      context: {
        currentPhase: checkpoint.currentPhase,
        lastSuccessfulStep: checkpoint.currentContext.lastSuccessfulStep,
        accumulatedKnowledgeCount: checkpoint.currentContext.accumulatedKnowledge.length,
      },

      // Metadata
      meta: {
        goalRunId: checkpoint.goalRunId,
        version: checkpoint.version,
        checkpointedAt: checkpoint.checkpointedAt,
        goalDescription: checkpoint.goalDescription,
      },
    };

    return {
      success: true,
      data: visualization,
    };
  }

  /**
   * Get checkpoint as formatted text (Manus-style todo.md)
   */
  @Get(':goalRunId/formatted')
  @ApiOperation({ summary: 'Get checkpoint as formatted text (todo.md style)' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiQuery({ name: 'maxTokens', required: false, description: 'Max tokens for output' })
  @ApiResponse({ status: 200, description: 'Formatted checkpoint retrieved' })
  async getFormattedCheckpoint(
    @Param('goalRunId') goalRunId: string,
    @Query('maxTokens') maxTokens?: string,
  ) {
    const formatted = await this.checkpointService.getCheckpointAsContext(goalRunId);

    if (!formatted) {
      throw new HttpException('Checkpoint not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      data: {
        formatted,
        tokenEstimate: Math.ceil(formatted.length / 4),
      },
    };
  }

  /**
   * Get knowledge graph for a goal run
   */
  @Get(':goalRunId/knowledge')
  @ApiOperation({ summary: 'Get accumulated knowledge for a goal run' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Knowledge graph retrieved' })
  async getKnowledge(@Param('goalRunId') goalRunId: string) {
    const knowledge = this.knowledgeService.getKnowledge(goalRunId);

    return {
      success: true,
      data: knowledge,
      formatted: this.knowledgeService.formatForContext(goalRunId),
    };
  }

  /**
   * Get context status for a goal run
   */
  @Get(':goalRunId/context-status')
  @ApiOperation({ summary: 'Get context window status' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Context status retrieved' })
  async getContextStatus(@Param('goalRunId') goalRunId: string) {
    // Get checkpoint items and check context status
    const checkpoint = await this.checkpointService.getCheckpoint(goalRunId);

    if (!checkpoint) {
      throw new HttpException('Checkpoint not found', HttpStatus.NOT_FOUND);
    }

    // Convert checkpoint to context items for status check
    const contextItems = checkpoint.completedWork.map(work => ({
      id: `work-${work.stepNumber}`,
      type: 'step_result' as const,
      timestamp: work.completedAt,
      content: `${work.description}: ${work.outcome}`,
      metadata: {
        stepNumber: work.stepNumber,
        importance: 'high' as const,
      },
    }));

    const status = this.contextService.getContextStatus(contextItems);

    return {
      success: true,
      data: {
        ...status,
        recommendedAction: status.needsSummarization
          ? 'Consider summarizing context to reduce token usage'
          : 'Context within acceptable limits',
      },
    };
  }

  /**
   * Recover checkpoint from persistence
   */
  @Post(':goalRunId/recover')
  @ApiOperation({ summary: 'Recover checkpoint from persistence' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiQuery({ name: 'version', required: false, description: 'Specific version to recover' })
  @ApiResponse({ status: 200, description: 'Checkpoint recovered' })
  async recoverCheckpoint(
    @Param('goalRunId') goalRunId: string,
    @Query('version') version?: string,
  ) {
    const result = await this.persistenceService.recoverCheckpoint(
      goalRunId,
      version ? parseInt(version, 10) : undefined,
    );

    if (!result.success) {
      throw new HttpException(result.message, HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      data: {
        recoveredFromVersion: result.recoveredFromVersion,
        message: result.message,
        checkpoint: result.checkpoint,
      },
    };
  }

  /**
   * Delete checkpoint for a goal run
   */
  @Delete(':goalRunId')
  @ApiOperation({ summary: 'Delete checkpoint for a goal run' })
  @ApiParam({ name: 'goalRunId', description: 'Goal run ID' })
  @ApiResponse({ status: 200, description: 'Checkpoint deleted' })
  async deleteCheckpoint(@Param('goalRunId') goalRunId: string) {
    const deleted = await this.persistenceService.deleteCheckpoint(goalRunId);
    this.knowledgeService.clearKnowledge(goalRunId);

    return {
      success: true,
      data: {
        deleted,
        message: deleted ? 'Checkpoint deleted' : 'No checkpoint found',
      },
    };
  }

  /**
   * Get checkpoint persistence statistics
   */
  @Get('stats/overview')
  @ApiOperation({ summary: 'Get checkpoint persistence statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStats() {
    const persistenceStats = await this.persistenceService.getStats();
    const backgroundStats = this.backgroundService.getQueueStats();

    return {
      success: true,
      data: {
        persistence: persistenceStats,
        background: backgroundStats,
      },
    };
  }

  /**
   * Get background task status
   */
  @Get('background-tasks/:taskId')
  @ApiOperation({ summary: 'Get background task status' })
  @ApiParam({ name: 'taskId', description: 'Background task ID' })
  @ApiResponse({ status: 200, description: 'Task status retrieved' })
  async getBackgroundTaskStatus(@Param('taskId') taskId: string) {
    const status = this.backgroundService.getTaskStatus(taskId);

    if (!status) {
      throw new HttpException('Task not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      data: status,
    };
  }

  /**
   * Cancel a background task
   */
  @Post('background-tasks/:taskId/cancel')
  @ApiOperation({ summary: 'Cancel a background task' })
  @ApiParam({ name: 'taskId', description: 'Background task ID' })
  @ApiResponse({ status: 200, description: 'Task cancelled' })
  async cancelBackgroundTask(@Param('taskId') taskId: string) {
    const cancelled = await this.backgroundService.cancelTask(taskId);

    if (!cancelled) {
      throw new HttpException('Task not found or already completed', HttpStatus.BAD_REQUEST);
    }

    return {
      success: true,
      data: {
        taskId,
        message: 'Task cancelled',
      },
    };
  }

  /**
   * Calculate duration between steps
   */
  private calculateDuration(
    completedWork: Array<{ stepNumber: number; completedAt: Date }>,
    currentIndex: number,
  ): number | null {
    if (currentIndex === 0) {
      return null; // Can't calculate first step duration without start time
    }

    const currentStep = completedWork[currentIndex];
    const previousStep = completedWork[currentIndex - 1];

    if (!currentStep?.completedAt || !previousStep?.completedAt) {
      return null;
    }

    return new Date(currentStep.completedAt).getTime() -
           new Date(previousStep.completedAt).getTime();
  }
}
