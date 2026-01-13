/**
 * Maintenance Mode Service
 * v1.0.0: Phase E - Maintenance mode handling
 *
 * Provides graceful maintenance mode handling for the orchestrator:
 * - State machine: RUNNING -> ENTERING_MAINTENANCE -> MAINTENANCE -> EXITING_MAINTENANCE -> RUNNING
 * - Graceful drain: Stops new work, allows in-progress work to complete
 * - Automatic pause: Pauses all running goal runs during maintenance
 * - Notification: Emits activity events for visibility
 *
 * Key behaviors:
 * - In ENTERING_MAINTENANCE: Reject new goal runs, allow in-progress to continue
 * - In MAINTENANCE: All goal runs paused, no new work accepted
 * - In EXITING_MAINTENANCE: Resume paused goal runs, accept new work
 *
 * @see Phase E documentation
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { GoalRunPhase, GoalRunStatus } from './goal-run.service';

// Maintenance mode states
export enum MaintenanceState {
  RUNNING = 'RUNNING',
  ENTERING_MAINTENANCE = 'ENTERING_MAINTENANCE',
  MAINTENANCE = 'MAINTENANCE',
  EXITING_MAINTENANCE = 'EXITING_MAINTENANCE',
}

// Configuration defaults
const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to drain
const DEFAULT_DRAIN_CHECK_INTERVAL_MS = 5 * 1000; // Check every 5 seconds

export interface MaintenanceStatus {
  state: MaintenanceState;
  inMaintenance: boolean;
  acceptingNewWork: boolean;
  reason?: string;
  initiatedBy?: string;
  startedAt?: Date;
  expectedEndAt?: Date;
  drainProgress?: {
    activeGoalRuns: number;
    pausedGoalRuns: number;
    drainTimeoutMs: number;
    drainElapsedMs: number;
  };
}

export interface EnterMaintenanceOptions {
  reason?: string;
  initiatedBy?: string;
  expectedDurationMs?: number;
  drainTimeoutMs?: number;
  force?: boolean; // If true, immediately pause all without waiting for drain
}

@Injectable()
export class MaintenanceModeService implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceModeService.name);

  // Current state
  private state: MaintenanceState = MaintenanceState.RUNNING;
  private reason?: string;
  private initiatedBy?: string;
  private startedAt?: Date;
  private expectedEndAt?: Date;
  private drainTimeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS;
  private drainStartedAt?: Date;

  // Drain timer
  private drainCheckInterval?: NodeJS.Timeout;

  // Track goal runs paused by maintenance (to resume them on exit)
  private pausedByMaintenance: Set<string> = new Set();

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    // Check if there's a persisted maintenance state on startup
    await this.loadPersistedState();
  }

  /**
   * Load persisted maintenance state from database (if any)
   */
  private async loadPersistedState(): Promise<void> {
    try {
      const config = await this.prisma.systemConfig.findUnique({
        where: { key: 'MAINTENANCE_MODE' },
      });

      if (config?.value) {
        const persisted = JSON.parse(config.value);
        if (persisted.state && persisted.state !== MaintenanceState.RUNNING) {
          this.logger.warn(
            `Found persisted maintenance state: ${persisted.state}. ` +
            `Restoring maintenance mode.`
          );
          this.state = persisted.state;
          this.reason = persisted.reason;
          this.initiatedBy = persisted.initiatedBy;
          this.startedAt = persisted.startedAt ? new Date(persisted.startedAt) : undefined;
          this.expectedEndAt = persisted.expectedEndAt ? new Date(persisted.expectedEndAt) : undefined;
        }
      }
    } catch (error: any) {
      // SystemConfig table might not exist yet
      this.logger.debug(`Could not load maintenance state: ${error.message}`);
    }
  }

  /**
   * Persist current maintenance state to database
   */
  private async persistState(): Promise<void> {
    try {
      const value = JSON.stringify({
        state: this.state,
        reason: this.reason,
        initiatedBy: this.initiatedBy,
        startedAt: this.startedAt?.toISOString(),
        expectedEndAt: this.expectedEndAt?.toISOString(),
      });

      await this.prisma.systemConfig.upsert({
        where: { key: 'MAINTENANCE_MODE' },
        create: { key: 'MAINTENANCE_MODE', value },
        update: { value },
      });
    } catch (error: any) {
      // Log but don't fail - in-memory state is authoritative
      this.logger.warn(`Could not persist maintenance state: ${error.message}`);
    }
  }

  /**
   * Get current maintenance status
   */
  getStatus(): MaintenanceStatus {
    const drainElapsedMs = this.drainStartedAt
      ? Date.now() - this.drainStartedAt.getTime()
      : 0;

    return {
      state: this.state,
      inMaintenance: this.state === MaintenanceState.MAINTENANCE,
      acceptingNewWork: this.state === MaintenanceState.RUNNING ||
                        this.state === MaintenanceState.EXITING_MAINTENANCE,
      reason: this.reason,
      initiatedBy: this.initiatedBy,
      startedAt: this.startedAt,
      expectedEndAt: this.expectedEndAt,
      drainProgress: this.state === MaintenanceState.ENTERING_MAINTENANCE ? {
        activeGoalRuns: 0, // Will be populated when queried
        pausedGoalRuns: this.pausedByMaintenance.size,
        drainTimeoutMs: this.drainTimeoutMs,
        drainElapsedMs,
      } : undefined,
    };
  }

  /**
   * Check if new work should be accepted
   */
  shouldAcceptNewWork(): boolean {
    return this.state === MaintenanceState.RUNNING ||
           this.state === MaintenanceState.EXITING_MAINTENANCE;
  }

  /**
   * Check if orchestrator should skip execution (maintenance mode)
   */
  shouldSkipExecution(): boolean {
    return this.state === MaintenanceState.MAINTENANCE;
  }

  /**
   * Check if in draining state
   */
  isDraining(): boolean {
    return this.state === MaintenanceState.ENTERING_MAINTENANCE;
  }

  /**
   * Enter maintenance mode
   * Begins graceful drain process
   */
  async enterMaintenance(options: EnterMaintenanceOptions = {}): Promise<MaintenanceStatus> {
    if (this.state !== MaintenanceState.RUNNING) {
      this.logger.warn(`Cannot enter maintenance: already in state ${this.state}`);
      return this.getStatus();
    }

    this.logger.log(
      `Entering maintenance mode: ${options.reason || 'No reason provided'} ` +
      `(initiated by: ${options.initiatedBy || 'system'})`
    );

    // Update state
    this.state = MaintenanceState.ENTERING_MAINTENANCE;
    this.reason = options.reason;
    this.initiatedBy = options.initiatedBy;
    this.startedAt = new Date();
    this.drainTimeoutMs = options.drainTimeoutMs || DEFAULT_DRAIN_TIMEOUT_MS;
    this.drainStartedAt = new Date();

    if (options.expectedDurationMs) {
      this.expectedEndAt = new Date(Date.now() + options.expectedDurationMs);
    }

    // Persist state
    await this.persistState();

    // Emit event for visibility
    this.eventEmitter.emit('maintenance.entering', {
      reason: this.reason,
      initiatedBy: this.initiatedBy,
      expectedEndAt: this.expectedEndAt,
    });

    // If force mode, immediately pause everything
    if (options.force) {
      this.logger.warn('Force maintenance mode: immediately pausing all goal runs');
      await this.pauseAllRunningGoalRuns();
      await this.transitionToMaintenance();
      return this.getStatus();
    }

    // Start drain check interval
    this.startDrainCheck();

    return this.getStatus();
  }

  /**
   * Start periodic check for drain completion
   */
  private startDrainCheck(): void {
    if (this.drainCheckInterval) {
      clearInterval(this.drainCheckInterval);
    }

    this.drainCheckInterval = setInterval(async () => {
      await this.checkDrainProgress();
    }, DEFAULT_DRAIN_CHECK_INTERVAL_MS);
  }

  /**
   * Check drain progress and transition when complete
   */
  private async checkDrainProgress(): Promise<void> {
    if (this.state !== MaintenanceState.ENTERING_MAINTENANCE) {
      this.stopDrainCheck();
      return;
    }

    const drainElapsedMs = this.drainStartedAt
      ? Date.now() - this.drainStartedAt.getTime()
      : 0;

    // Get count of active goal runs
    const activeGoalRuns = await this.prisma.goalRun.count({
      where: {
        status: GoalRunStatus.RUNNING,
        phase: {
          notIn: [GoalRunPhase.COMPLETED, GoalRunPhase.FAILED, GoalRunPhase.PAUSED],
        },
      },
    });

    this.logger.debug(
      `Drain progress: ${activeGoalRuns} active goal runs, ` +
      `elapsed ${Math.round(drainElapsedMs / 1000)}s / ${Math.round(this.drainTimeoutMs / 1000)}s`
    );

    // If all drained or timeout, transition to maintenance
    if (activeGoalRuns === 0) {
      this.logger.log('All goal runs drained, transitioning to maintenance');
      await this.transitionToMaintenance();
    } else if (drainElapsedMs >= this.drainTimeoutMs) {
      this.logger.warn(
        `Drain timeout reached with ${activeGoalRuns} active goal runs. ` +
        `Forcing pause and transitioning to maintenance.`
      );
      await this.pauseAllRunningGoalRuns();
      await this.transitionToMaintenance();
    }
  }

  /**
   * Stop drain check interval
   */
  private stopDrainCheck(): void {
    if (this.drainCheckInterval) {
      clearInterval(this.drainCheckInterval);
      this.drainCheckInterval = undefined;
    }
  }

  /**
   * Transition to maintenance state
   */
  private async transitionToMaintenance(): Promise<void> {
    this.stopDrainCheck();
    this.state = MaintenanceState.MAINTENANCE;
    this.drainStartedAt = undefined;

    await this.persistState();

    this.logger.log('Entered maintenance mode');

    // Emit event
    this.eventEmitter.emit('maintenance.entered', {
      reason: this.reason,
      initiatedBy: this.initiatedBy,
      pausedGoalRuns: this.pausedByMaintenance.size,
    });
  }

  /**
   * Pause all running goal runs for maintenance
   */
  private async pauseAllRunningGoalRuns(): Promise<number> {
    const runningGoalRuns = await this.prisma.goalRun.findMany({
      where: {
        status: GoalRunStatus.RUNNING,
        phase: {
          notIn: [GoalRunPhase.COMPLETED, GoalRunPhase.FAILED, GoalRunPhase.PAUSED],
        },
      },
      select: { id: true },
    });

    let pausedCount = 0;
    for (const goalRun of runningGoalRuns) {
      try {
        await this.prisma.goalRun.update({
          where: { id: goalRun.id },
          data: { phase: GoalRunPhase.PAUSED },
        });
        this.pausedByMaintenance.add(goalRun.id);
        pausedCount++;

        // Create activity event for this goal run
        await this.prisma.activityEvent.create({
          data: {
            goalRunId: goalRun.id,
            eventType: 'MAINTENANCE_PAUSED',
            title: 'Paused for system maintenance',
            description: this.reason || 'System entering maintenance mode',
            severity: 'warning',
          },
        });
      } catch (error: any) {
        this.logger.error(`Failed to pause goal run ${goalRun.id}: ${error.message}`);
      }
    }

    this.logger.log(`Paused ${pausedCount} goal runs for maintenance`);
    return pausedCount;
  }

  /**
   * Exit maintenance mode
   * Resumes goal runs that were paused by maintenance
   */
  async exitMaintenance(): Promise<MaintenanceStatus> {
    if (this.state !== MaintenanceState.MAINTENANCE &&
        this.state !== MaintenanceState.ENTERING_MAINTENANCE) {
      this.logger.warn(`Cannot exit maintenance: in state ${this.state}`);
      return this.getStatus();
    }

    this.logger.log('Exiting maintenance mode');

    this.stopDrainCheck();
    this.state = MaintenanceState.EXITING_MAINTENANCE;

    await this.persistState();

    // Emit event
    this.eventEmitter.emit('maintenance.exiting', {
      pausedGoalRunsToResume: this.pausedByMaintenance.size,
    });

    // Resume goal runs that were paused by maintenance
    let resumedCount = 0;
    for (const goalRunId of this.pausedByMaintenance) {
      try {
        // Check if still exists and is paused
        const goalRun = await this.prisma.goalRun.findUnique({
          where: { id: goalRunId },
          include: { planVersions: true },
        });

        if (goalRun && goalRun.phase === GoalRunPhase.PAUSED) {
          // Determine resume phase (executing if plan exists, planning if not)
          const resumePhase = goalRun.planVersions.length > 0
            ? GoalRunPhase.EXECUTING
            : GoalRunPhase.PLANNING;

          await this.prisma.goalRun.update({
            where: { id: goalRunId },
            data: { phase: resumePhase },
          });

          // Create activity event
          await this.prisma.activityEvent.create({
            data: {
              goalRunId,
              eventType: 'MAINTENANCE_RESUMED',
              title: 'Resumed after maintenance',
              description: 'System maintenance completed, resuming execution',
            },
          });

          resumedCount++;
        }
      } catch (error: any) {
        this.logger.error(`Failed to resume goal run ${goalRunId}: ${error.message}`);
      }
    }

    this.pausedByMaintenance.clear();
    this.logger.log(`Resumed ${resumedCount} goal runs after maintenance`);

    // Transition to running
    this.state = MaintenanceState.RUNNING;
    this.reason = undefined;
    this.initiatedBy = undefined;
    this.startedAt = undefined;
    this.expectedEndAt = undefined;

    await this.persistState();

    // Emit event
    this.eventEmitter.emit('maintenance.exited', {
      resumedGoalRuns: resumedCount,
    });

    this.logger.log('Exited maintenance mode');

    return this.getStatus();
  }

  /**
   * Handle module destroy - clean up intervals
   */
  onModuleDestroy() {
    this.stopDrainCheck();
  }
}
