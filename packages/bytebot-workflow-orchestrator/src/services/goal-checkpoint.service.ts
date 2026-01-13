/**
 * Goal Checkpoint Service
 * v1.0.0: Manus-style External State Management
 *
 * This service implements external state persistence patterns inspired by:
 * - Manus AI: todo.md file that's "constantly rewritten" to keep progress visible
 * - LangGraph: Checkpoint at every superstep for fault tolerance
 * - OpenAI Assistants: Thread state persistence across interactions
 *
 * Key Features:
 * 1. Maintains JSON checkpoint of goal state after each step
 * 2. Provides structured context for replanning
 * 3. Enables recovery from any point without re-running successful steps
 * 4. Keeps completed work "in the model's recent attention span" (Manus pattern)
 *
 * The checkpoint is stored in the database but can optionally be
 * serialized to a file for debugging/recovery.
 *
 * @see /documentation/2026-01-03-CONTEXT_PRESERVING_REPLAN_FIX.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';

// Checkpoint structure - Manus-style todo.md in JSON form
export interface GoalCheckpoint {
  // Metadata
  goalRunId: string;
  goalDescription: string;
  version: number;
  checkpointedAt: Date;
  currentPhase: string;

  // Progress summary (Manus-style "constantly rewritten" todo)
  progressSummary: {
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    pendingSteps: number;
    percentComplete: number;
  };

  // Completed work with outcomes (the key context for replanning)
  completedWork: {
    stepNumber: number;
    description: string;
    outcome: string;
    completedAt: Date;
  }[];

  // Current context for the agent
  currentContext: {
    lastSuccessfulStep?: string;
    lastSuccessfulOutcome?: string;
    currentStep?: string;
    failureReason?: string;
    accumulatedKnowledge: string[]; // Key facts learned during execution
  };

  // Remaining work
  remainingSteps: {
    stepNumber: number;
    description: string;
    status: string;
    dependsOnCompleted: boolean;
  }[];
}

// Checkpoint storage in database
export interface CheckpointRecord {
  goalRunId: string;
  checkpoint: GoalCheckpoint;
  createdAt: Date;
}

@Injectable()
export class GoalCheckpointService {
  private readonly logger = new Logger(GoalCheckpointService.name);
  private readonly enabled: boolean;

  // In-memory cache for quick access (also persisted to DB)
  private checkpointCache: Map<string, GoalCheckpoint> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('CHECKPOINT_ENABLED', 'true') === 'true';
    this.logger.log(`Goal checkpoint service ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Create or update checkpoint for a goal run
   *
   * Called after each step completion to maintain current state.
   * Implements Manus-style "constantly rewriting the todo list".
   */
  async updateCheckpoint(goalRunId: string): Promise<GoalCheckpoint | null> {
    if (!this.enabled) {
      return null;
    }

    this.logger.debug(`Updating checkpoint for goal run ${goalRunId}`);

    try {
      // Fetch current goal run state with all related data
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
        this.logger.warn(`Goal run ${goalRunId} not found for checkpoint`);
        return null;
      }

      const currentPlan = goalRun.planVersions[0];
      const items = currentPlan?.checklistItems || [];

      // Build checkpoint
      const checkpoint = this.buildCheckpoint(goalRun, items);

      // Store in cache
      this.checkpointCache.set(goalRunId, checkpoint);

      // Persist to database (store in goal run's JSON field if available)
      await this.persistCheckpoint(goalRunId, checkpoint);

      // Emit event for monitoring
      this.eventEmitter.emit('checkpoint.updated', {
        goalRunId,
        version: checkpoint.version,
        percentComplete: checkpoint.progressSummary.percentComplete,
      });

      this.logger.debug(
        `Checkpoint updated: ${checkpoint.progressSummary.completedSteps}/${checkpoint.progressSummary.totalSteps} complete`,
      );

      return checkpoint;
    } catch (error) {
      this.logger.error(`Failed to update checkpoint: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Get the current checkpoint for a goal run
   */
  async getCheckpoint(goalRunId: string): Promise<GoalCheckpoint | null> {
    // Check cache first
    const cached = this.checkpointCache.get(goalRunId);
    if (cached) {
      return cached;
    }

    // Load from database
    return this.loadCheckpoint(goalRunId);
  }

  /**
   * Get checkpoint as formatted string for LLM context
   *
   * This implements the Manus-style "todo.md" format - a concise,
   * human-readable summary of progress that can be included in prompts.
   */
  async getCheckpointAsContext(goalRunId: string): Promise<string> {
    const checkpoint = await this.getCheckpoint(goalRunId);
    if (!checkpoint) {
      return '';
    }

    return this.formatCheckpointForLLM(checkpoint);
  }

  /**
   * Build checkpoint from goal run state
   */
  private buildCheckpoint(goalRun: any, items: any[]): GoalCheckpoint {
    const completedItems = items.filter(i => i.status === 'COMPLETED');
    const failedItems = items.filter(i => i.status === 'FAILED');
    const pendingItems = items.filter(i => i.status === 'PENDING' || i.status === 'IN_PROGRESS');
    const inProgressItem = items.find(i => i.status === 'IN_PROGRESS');

    // Extract accumulated knowledge from completed outcomes
    const accumulatedKnowledge = this.extractKnowledge(completedItems);

    // Find last successful step
    const lastCompleted = completedItems[completedItems.length - 1];

    return {
      goalRunId: goalRun.id,
      goalDescription: goalRun.goal,
      version: goalRun.currentPlanVersion || 1,
      checkpointedAt: new Date(),
      currentPhase: goalRun.phase,

      progressSummary: {
        totalSteps: items.length,
        completedSteps: completedItems.length,
        failedSteps: failedItems.length,
        pendingSteps: pendingItems.length,
        percentComplete: items.length > 0
          ? Math.round((completedItems.length / items.length) * 100)
          : 0,
      },

      completedWork: completedItems.map(item => ({
        stepNumber: item.order,
        description: item.description,
        outcome: item.actualOutcome || 'Completed successfully',
        completedAt: item.completedAt || new Date(),
      })),

      currentContext: {
        lastSuccessfulStep: lastCompleted?.description,
        lastSuccessfulOutcome: lastCompleted?.actualOutcome,
        currentStep: inProgressItem?.description,
        failureReason: failedItems[0]?.actualOutcome,
        accumulatedKnowledge,
      },

      remainingSteps: pendingItems.map(item => ({
        stepNumber: item.order,
        description: item.description,
        status: item.status,
        dependsOnCompleted: item.order > 1 && completedItems.length > 0,
      })),
    };
  }

  /**
   * Extract key knowledge/facts from completed step outcomes
   *
   * This helps maintain context even when replanning.
   */
  private extractKnowledge(completedItems: any[]): string[] {
    const knowledge: string[] = [];

    for (const item of completedItems) {
      if (!item.actualOutcome) continue;

      try {
        // Try to parse JSON outcome for structured data
        const parsed = JSON.parse(item.actualOutcome);
        if (typeof parsed === 'object' && parsed !== null) {
          // Extract key facts from structured outcome
          if (parsed.summary) knowledge.push(parsed.summary);
          if (parsed.result) knowledge.push(String(parsed.result));
          if (parsed.found) knowledge.push(`Found: ${JSON.stringify(parsed.found)}`);
        }
      } catch {
        // Plain text outcome - use directly if not too long
        if (item.actualOutcome.length < 200) {
          knowledge.push(`Step ${item.order}: ${item.actualOutcome}`);
        } else {
          knowledge.push(`Step ${item.order}: ${item.actualOutcome.substring(0, 200)}...`);
        }
      }
    }

    return knowledge;
  }

  /**
   * Format checkpoint as context string for LLM prompts
   *
   * This is the Manus-style "todo.md" format - keeps completed work
   * in the model's recent attention span.
   */
  private formatCheckpointForLLM(checkpoint: GoalCheckpoint): string {
    const lines: string[] = [];

    lines.push(`# Goal Progress Checkpoint (v${checkpoint.version})`);
    lines.push(`Goal: ${checkpoint.goalDescription}`);
    lines.push(`Progress: ${checkpoint.progressSummary.completedSteps}/${checkpoint.progressSummary.totalSteps} steps (${checkpoint.progressSummary.percentComplete}%)`);
    lines.push('');

    if (checkpoint.completedWork.length > 0) {
      lines.push('## Completed Work');
      for (const work of checkpoint.completedWork) {
        lines.push(`- [x] Step ${work.stepNumber}: ${work.description}`);
        lines.push(`      Result: ${work.outcome}`);
      }
      lines.push('');
    }

    if (checkpoint.currentContext.accumulatedKnowledge.length > 0) {
      lines.push('## Key Information Gathered');
      for (const knowledge of checkpoint.currentContext.accumulatedKnowledge) {
        lines.push(`- ${knowledge}`);
      }
      lines.push('');
    }

    if (checkpoint.remainingSteps.length > 0) {
      lines.push('## Remaining Steps');
      for (const step of checkpoint.remainingSteps) {
        const status = step.status === 'IN_PROGRESS' ? '[~]' : '[ ]';
        lines.push(`- ${status} Step ${step.stepNumber}: ${step.description}`);
      }
      lines.push('');
    }

    if (checkpoint.currentContext.failureReason) {
      lines.push('## Last Failure');
      lines.push(`Reason: ${checkpoint.currentContext.failureReason}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Persist checkpoint to database
   *
   * We store the checkpoint in a dedicated JSON column if available,
   * or in the goal run's existing JSON fields.
   */
  private async persistCheckpoint(goalRunId: string, checkpoint: GoalCheckpoint): Promise<void> {
    try {
      // Store in constraints field (which is JSON) with a special key
      const goalRun = await this.prisma.goalRun.findUnique({
        where: { id: goalRunId },
        select: { constraints: true },
      });

      const constraints = (goalRun?.constraints as any) || {};
      constraints._checkpoint = checkpoint;

      await this.prisma.goalRun.update({
        where: { id: goalRunId },
        data: {
          constraints,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to persist checkpoint: ${(error as Error).message}`);
    }
  }

  /**
   * Load checkpoint from database
   */
  private async loadCheckpoint(goalRunId: string): Promise<GoalCheckpoint | null> {
    try {
      const goalRun = await this.prisma.goalRun.findUnique({
        where: { id: goalRunId },
        select: { constraints: true },
      });

      const constraints = (goalRun?.constraints as any) || {};
      const checkpoint = constraints._checkpoint as GoalCheckpoint;

      if (checkpoint) {
        // Update cache
        this.checkpointCache.set(goalRunId, checkpoint);
        return checkpoint;
      }

      return null;
    } catch (error) {
      this.logger.warn(`Failed to load checkpoint: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Clear checkpoint (on goal completion or cancellation)
   */
  async clearCheckpoint(goalRunId: string): Promise<void> {
    this.checkpointCache.delete(goalRunId);

    try {
      const goalRun = await this.prisma.goalRun.findUnique({
        where: { id: goalRunId },
        select: { constraints: true },
      });

      if (goalRun) {
        const constraints = (goalRun.constraints as any) || {};
        delete constraints._checkpoint;

        await this.prisma.goalRun.update({
          where: { id: goalRunId },
          data: { constraints },
        });
      }
    } catch (error) {
      this.logger.warn(`Failed to clear checkpoint: ${(error as Error).message}`);
    }
  }
}
