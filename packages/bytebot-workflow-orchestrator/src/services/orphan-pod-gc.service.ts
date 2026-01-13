/**
 * Orphan Pod Garbage Collection Service
 * v1.2.0: DB transient error resilience for GC cycles
 * v1.1.0: Added Phase 3 - Idle workspace hibernation (configurable idle threshold)
 * v1.0.0: Detects and cleans up orphan workspace pods
 *
 * This service runs on a schedule to find and delete pods that should have
 * been hibernated but weren't due to transient failures or are idle.
 *
 * Orphan pods can occur when:
 * - Workflow completion/cancellation failed to hibernate the workspace
 * - Network issues caused hibernation API calls to fail
 * - Task controller was unavailable during hibernation
 * - Workspace is idle with no active goal run (v1.1.0)
 *
 * The service:
 * 1. Queries workspaces with HIBERNATION_FAILED status
 * 2. Queries completed/failed/cancelled workflows older than grace period
 * 3. Queries idle workspaces with no active goal run (v1.1.0)
 * 4. Attempts to delete pods via task-controller
 * 5. Updates workspace status on success
 * 6. Logs metrics for monitoring
 *
 * v1.2.0: Wrapped in DbTransientService for DB restart resilience
 *
 * @see https://book.kubebuilder.io/reference/good-practices (garbage collection)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { DbTransientService } from './db-transient.service';
import { WorkspaceService } from './workspace.service';

export interface OrphanPodGCResult {
  checked: number;
  cleaned: number;
  failed: number;
  errors: string[];
}

@Injectable()
export class OrphanPodGCService implements OnModuleInit {
  private readonly logger = new Logger(OrphanPodGCService.name);
  private isRunning = false;

  // Grace period before considering a completed workflow's pod as orphaned
  // Default: 5 minutes to allow for normal cleanup
  private readonly gracePeriodMs: number;

  // Max retries for hibernation before giving up
  private readonly maxRetries: number;

  // Whether GC is enabled
  private readonly enabled: boolean;

  // v1.1.0: Idle threshold - hibernate workspaces with no active goal run
  // after this many minutes of inactivity
  // Default: 30 minutes - prevents all-day slot pinning without data loss
  private readonly idleThresholdMs: number;

  // v1.1.0: Whether idle workspace hibernation is enabled
  private readonly idleHibernationEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dbTransientService: DbTransientService,
    private readonly workspaceService: WorkspaceService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.gracePeriodMs = this.configService.get<number>(
      'ORPHAN_GC_GRACE_PERIOD_MS',
      5 * 60 * 1000, // 5 minutes
    );
    this.maxRetries = this.configService.get<number>(
      'ORPHAN_GC_MAX_RETRIES',
      5,
    );
    this.enabled = this.configService.get<boolean>(
      'ORPHAN_GC_ENABLED',
      true,
    );
    // v1.1.0: Idle workspace hibernation configuration
    const idleMinutes = parseInt(
      this.configService.get<string>('WORKSPACE_IDLE_HIBERNATE_MINUTES', '30'),
      10,
    );
    this.idleThresholdMs = idleMinutes * 60 * 1000;
    this.idleHibernationEnabled = this.configService.get<boolean>(
      'WORKSPACE_IDLE_HIBERNATE_ENABLED',
      true,
    );
  }

  onModuleInit() {
    this.logger.log(
      `OrphanPodGCService initialized (enabled=${this.enabled}, ` +
      `gracePeriod=${this.gracePeriodMs}ms, maxRetries=${this.maxRetries}, ` +
      `idleHibernation=${this.idleHibernationEnabled}, idleThreshold=${this.idleThresholdMs}ms)`,
    );
  }

  /**
   * Run GC every 5 minutes
   * v1.2.0: Wrapped in transient guard for DB resilience
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runScheduledGC(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    // v1.2.0: Skip if in DB backoff
    if (this.dbTransientService.isInBackoff()) {
      this.logger.debug(
        `Orphan GC skipped - DB backoff (${Math.round(this.dbTransientService.getBackoffRemainingMs() / 1000)}s remaining)`,
      );
      return;
    }

    if (this.isRunning) {
      this.logger.debug('Orphan GC already running, skipping');
      return;
    }

    // v1.2.0: Wrap in transient guard
    await this.dbTransientService.withTransientGuard(
      async () => {
        await this.runGC();
      },
      'OrphanPodGC.runScheduledGC',
      {
        onTransientError: (error, backoffMs) => {
          this.logger.warn(
            `Orphan GC cycle interrupted by DB error, will retry ` +
            `(backoff: ${Math.round(backoffMs / 1000)}s): ${error.message}`,
          );
        },
      },
    );
  }

  /**
   * Run orphan pod garbage collection
   * Can be called manually or via cron
   */
  async runGC(): Promise<OrphanPodGCResult> {
    this.isRunning = true;
    const result: OrphanPodGCResult = {
      checked: 0,
      cleaned: 0,
      failed: 0,
      errors: [],
    };

    try {
      this.logger.debug('Starting orphan pod GC cycle');

      // Phase 1: Clean up workspaces with HIBERNATION_FAILED status
      const hibernationFailedResult = await this.cleanupHibernationFailed();
      result.checked += hibernationFailedResult.checked;
      result.cleaned += hibernationFailedResult.cleaned;
      result.failed += hibernationFailedResult.failed;
      result.errors.push(...hibernationFailedResult.errors);

      // Phase 2: Clean up orphaned pods from completed workflows
      const completedWorkflowResult = await this.cleanupCompletedWorkflows();
      result.checked += completedWorkflowResult.checked;
      result.cleaned += completedWorkflowResult.cleaned;
      result.failed += completedWorkflowResult.failed;
      result.errors.push(...completedWorkflowResult.errors);

      // Phase 3 (v1.1.0): Clean up idle workspaces with no active goal run
      if (this.idleHibernationEnabled) {
        const idleWorkspaceResult = await this.cleanupIdleWorkspaces();
        result.checked += idleWorkspaceResult.checked;
        result.cleaned += idleWorkspaceResult.cleaned;
        result.failed += idleWorkspaceResult.failed;
        result.errors.push(...idleWorkspaceResult.errors);
      }

      if (result.checked > 0) {
        this.logger.log(
          `Orphan GC complete: checked=${result.checked}, ` +
          `cleaned=${result.cleaned}, failed=${result.failed}`,
        );
      }

      // Emit metrics event
      this.eventEmitter.emit('orphan-gc.completed', {
        timestamp: new Date(),
        ...result,
      });

      return result;
    } catch (error: any) {
      this.logger.error(`Orphan GC failed: ${error.message}`);
      result.errors.push(error.message);
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Phase 1: Clean up workspaces with HIBERNATION_FAILED status
   *
   * These are workspaces where the workflow.service tried to hibernate
   * but failed after retries. We'll try again here.
   */
  private async cleanupHibernationFailed(): Promise<OrphanPodGCResult> {
    const result: OrphanPodGCResult = {
      checked: 0,
      cleaned: 0,
      failed: 0,
      errors: [],
    };

    try {
      // Find workspaces with HIBERNATION_FAILED status
      // that haven't exceeded max retry count
      const failedWorkspaces = await this.prisma.workspace.findMany({
        where: {
          status: 'HIBERNATION_FAILED',
          hibernationAttemptCount: { lt: this.maxRetries },
        },
        select: {
          id: true,
          hibernationAttemptCount: true,
          lastHibernationAttemptAt: true,
          hibernationError: true,
          workflowRun: {
            select: { id: true },
          },
        },
        take: 50, // Process in batches
      });

      result.checked = failedWorkspaces.length;

      for (const workspace of failedWorkspaces) {
        try {
          // Check if enough time has passed since last attempt (exponential backoff)
          const lastAttempt = workspace.lastHibernationAttemptAt;
          if (lastAttempt) {
            const backoffMs = Math.min(
              30000 * Math.pow(2, workspace.hibernationAttemptCount),
              300000, // Max 5 minutes
            );
            const nextRetryAt = new Date(lastAttempt.getTime() + backoffMs);
            if (new Date() < nextRetryAt) {
              this.logger.debug(
                `Workspace ${workspace.id} not ready for retry (next: ${nextRetryAt.toISOString()})`,
              );
              continue;
            }
          }

          // Update attempt tracking
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              hibernationAttemptCount: workspace.hibernationAttemptCount + 1,
              lastHibernationAttemptAt: new Date(),
            },
          });

          // Attempt hibernation via task-controller
          await this.workspaceService.hibernateWorkspace(workspace.id);

          // Success - update status
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              status: 'HIBERNATED',
              hibernationError: null,
            },
          });

          this.logger.log(`GC: Workspace ${workspace.id} hibernated successfully`);
          result.cleaned++;
        } catch (error: any) {
          const errorMessage = error.message || 'Unknown error';

          // Check if pod not found (already deleted)
          if (errorMessage.includes('404') || errorMessage.includes('not found')) {
            // Pod already gone - mark as hibernated
            await this.prisma.workspace.update({
              where: { id: workspace.id },
              data: {
                status: 'HIBERNATED',
                hibernationError: null,
              },
            });
            this.logger.log(`GC: Workspace ${workspace.id} pod already deleted, marking hibernated`);
            result.cleaned++;
          } else {
            // Still failing - check if exceeded max retries
            const newAttemptCount = workspace.hibernationAttemptCount + 1;
            if (newAttemptCount >= this.maxRetries) {
              // Mark as permanently failed
              await this.prisma.workspace.update({
                where: { id: workspace.id },
                data: {
                  status: 'GC_FAILED',
                  hibernationError: `Max retries (${this.maxRetries}) exceeded: ${errorMessage}`,
                },
              });
              this.logger.error(
                `GC: Workspace ${workspace.id} max retries exceeded, marked as GC_FAILED`,
              );
            }

            result.failed++;
            result.errors.push(`${workspace.id}: ${errorMessage}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Phase 1 (HIBERNATION_FAILED) failed: ${error.message}`);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Phase 2: Clean up pods from completed workflows that weren't properly hibernated
   *
   * This catches cases where:
   * - The workflow was marked complete but hibernation never ran
   * - The workflow service crashed before hibernation
   * - Database was updated but side effect didn't run
   */
  private async cleanupCompletedWorkflows(): Promise<OrphanPodGCResult> {
    const result: OrphanPodGCResult = {
      checked: 0,
      cleaned: 0,
      failed: 0,
      errors: [],
    };

    try {
      const gracePeriodAgo = new Date(Date.now() - this.gracePeriodMs);

      // Find completed workflows with workspaces that aren't hibernated
      const potentialOrphans = await this.prisma.workflowRun.findMany({
        where: {
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          completedAt: { lt: gracePeriodAgo },
          workspace: {
            status: {
              notIn: ['HIBERNATED', 'TERMINATED', 'GC_FAILED', 'HIBERNATION_FAILED'],
            },
          },
        },
        select: {
          id: true,
          status: true,
          completedAt: true,
          workspace: {
            select: {
              id: true,
              status: true,
            },
          },
        },
        take: 50, // Process in batches
      });

      result.checked = potentialOrphans.length;

      for (const workflow of potentialOrphans) {
        if (!workflow.workspace) continue;

        try {
          // Check if pod actually exists before trying to delete
          const desktopStatus = await this.workspaceService.getWorkspaceDesktopStatus(
            workflow.workspace.id,
          );

          if (desktopStatus.status === 'NOT_FOUND') {
            // Pod already gone - just update DB
            await this.prisma.workspace.update({
              where: { id: workflow.workspace.id },
              data: { status: 'HIBERNATED' },
            });
            this.logger.log(
              `GC: Workspace ${workflow.workspace.id} pod not found, marking hibernated`,
            );
            result.cleaned++;
            continue;
          }

          // Pod exists - try to hibernate
          await this.workspaceService.hibernateWorkspace(workflow.workspace.id);

          await this.prisma.workspace.update({
            where: { id: workflow.workspace.id },
            data: {
              status: 'HIBERNATED',
              hibernationError: null,
            },
          });

          this.logger.log(
            `GC: Orphan workspace ${workflow.workspace.id} from workflow ${workflow.id} hibernated`,
          );
          result.cleaned++;
        } catch (error: any) {
          const errorMessage = error.message || 'Unknown error';

          // Handle 404 (pod already deleted)
          if (errorMessage.includes('404') || errorMessage.includes('not found')) {
            await this.prisma.workspace.update({
              where: { id: workflow.workspace.id },
              data: { status: 'HIBERNATED' },
            });
            this.logger.log(
              `GC: Workspace ${workflow.workspace.id} already deleted, marking hibernated`,
            );
            result.cleaned++;
          } else {
            // Mark for retry next cycle
            await this.prisma.workspace.update({
              where: { id: workflow.workspace.id },
              data: {
                status: 'HIBERNATION_FAILED',
                hibernationError: errorMessage,
                hibernationAttemptCount: 1,
                lastHibernationAttemptAt: new Date(),
              },
            });

            this.logger.warn(
              `GC: Failed to hibernate workspace ${workflow.workspace.id}: ${errorMessage}`,
            );
            result.failed++;
            result.errors.push(`${workflow.workspace.id}: ${errorMessage}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Phase 2 (completed workflows) failed: ${error.message}`);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Phase 3 (v1.1.0): Clean up idle workspaces with no active goal run
   *
   * This catches cases where:
   * - A workspace is ready but the associated goal run finished/cancelled
   * - A user started a task but never finished it
   * - The orchestrator loop stopped processing but the pod remained
   *
   * Idle detection logic:
   * - Workspace status is READY (pod is running)
   * - Associated workflow is RUNNING (not yet marked complete)
   * - Workspace updatedAt is older than idle threshold
   * - No active goal run (RUNNING status) for this workspace
   */
  private async cleanupIdleWorkspaces(): Promise<OrphanPodGCResult> {
    const result: OrphanPodGCResult = {
      checked: 0,
      cleaned: 0,
      failed: 0,
      errors: [],
    };

    try {
      const idleThresholdAgo = new Date(Date.now() - this.idleThresholdMs);

      // Find workspaces that:
      // 1. Are in READY status (pod is running)
      // 2. Have a workflow in RUNNING status (not yet marked complete)
      // 3. Haven't been updated in the idle threshold period
      // 4. Have no active goal run (status != RUNNING or no goal run at all)
      const idleWorkspaces = await this.prisma.workspace.findMany({
        where: {
          status: 'READY',
          updatedAt: { lt: idleThresholdAgo },
          workflowRun: {
            status: 'RUNNING',
            // No active goal run for this workflow
            // Either no goal run exists OR goal run is not RUNNING
            OR: [
              { goalRun: null },                    // No goal run linked
              { goalRun: { status: { not: 'RUNNING' } } },  // Goal run finished
            ],
          },
        },
        select: {
          id: true,
          updatedAt: true,
          workflowRun: {
            select: {
              id: true,
              goalRun: {
                select: {
                  id: true,
                  status: true,
                },
              },
            },
          },
        },
        take: 50, // Process in batches
      });

      result.checked = idleWorkspaces.length;

      for (const workspace of idleWorkspaces) {
        const idleMinutes = Math.round(
          (Date.now() - workspace.updatedAt.getTime()) / 60000,
        );
        const goalRunId = workspace.workflowRun?.goalRun?.id;
        const goalRunStatus = workspace.workflowRun?.goalRun?.status;

        try {
          this.logger.log(
            `GC: Hibernating idle workspace ${workspace.id} ` +
            `(idle ${idleMinutes}min, goalRun=${goalRunId || 'none'}, status=${goalRunStatus || 'none'})`,
          );

          // Check if pod actually exists
          const desktopStatus = await this.workspaceService.getWorkspaceDesktopStatus(
            workspace.id,
          );

          if (desktopStatus.status === 'NOT_FOUND') {
            // Pod already gone - just update DB
            await this.prisma.workspace.update({
              where: { id: workspace.id },
              data: { status: 'HIBERNATED' },
            });
            this.logger.log(
              `GC: Idle workspace ${workspace.id} pod not found, marking hibernated`,
            );
            result.cleaned++;
            continue;
          }

          // Pod exists - hibernate it
          await this.workspaceService.hibernateWorkspace(workspace.id);

          // Update workspace and workflow status
          await this.prisma.$transaction([
            this.prisma.workspace.update({
              where: { id: workspace.id },
              data: {
                status: 'HIBERNATED',
                hibernationError: null,
              },
            }),
            // Also mark workflow as cancelled since no goal run is active
            this.prisma.workflowRun.update({
              where: { id: workspace.workflowRun?.id },
              data: {
                status: 'CANCELLED',
                completedAt: new Date(),
                error: `Workspace hibernated after ${idleMinutes} minutes of inactivity`,
              },
            }),
          ]);

          this.logger.log(
            `GC: Idle workspace ${workspace.id} hibernated after ${idleMinutes} minutes`,
          );
          result.cleaned++;
        } catch (error: any) {
          const errorMessage = error.message || 'Unknown error';

          // Handle 404 (pod already deleted)
          if (errorMessage.includes('404') || errorMessage.includes('not found')) {
            await this.prisma.workspace.update({
              where: { id: workspace.id },
              data: { status: 'HIBERNATED' },
            });
            this.logger.log(
              `GC: Idle workspace ${workspace.id} already deleted, marking hibernated`,
            );
            result.cleaned++;
          } else {
            // Mark for retry next cycle
            await this.prisma.workspace.update({
              where: { id: workspace.id },
              data: {
                status: 'HIBERNATION_FAILED',
                hibernationError: `Idle hibernation failed: ${errorMessage}`,
                hibernationAttemptCount: 1,
                lastHibernationAttemptAt: new Date(),
              },
            });

            this.logger.warn(
              `GC: Failed to hibernate idle workspace ${workspace.id}: ${errorMessage}`,
            );
            result.failed++;
            result.errors.push(`${workspace.id}: ${errorMessage}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Phase 3 (idle workspaces) failed: ${error.message}`);
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Get current GC status and stats
   */
  async getStatus(): Promise<{
    enabled: boolean;
    isRunning: boolean;
    gracePeriodMs: number;
    maxRetries: number;
    idleHibernationEnabled: boolean;
    idleThresholdMs: number;
    pendingCleanup: {
      hibernationFailed: number;
      potentialOrphans: number;
      idleWorkspaces: number;
      gcFailed: number;
    };
  }> {
    const gracePeriodAgo = new Date(Date.now() - this.gracePeriodMs);
    const idleThresholdAgo = new Date(Date.now() - this.idleThresholdMs);

    const [hibernationFailed, potentialOrphans, idleWorkspaces, gcFailed] = await Promise.all([
      this.prisma.workspace.count({
        where: { status: 'HIBERNATION_FAILED' },
      }),
      this.prisma.workflowRun.count({
        where: {
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          completedAt: { lt: gracePeriodAgo },
          workspace: {
            status: {
              notIn: ['HIBERNATED', 'TERMINATED', 'GC_FAILED', 'HIBERNATION_FAILED'],
            },
          },
        },
      }),
      // v1.1.0: Count idle workspaces
      this.prisma.workspace.count({
        where: {
          status: 'READY',
          updatedAt: { lt: idleThresholdAgo },
          workflowRun: {
            status: 'RUNNING',
            OR: [
              { goalRun: null },
              { goalRun: { status: { not: 'RUNNING' } } },
            ],
          },
        },
      }),
      this.prisma.workspace.count({
        where: { status: 'GC_FAILED' },
      }),
    ]);

    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      gracePeriodMs: this.gracePeriodMs,
      maxRetries: this.maxRetries,
      idleHibernationEnabled: this.idleHibernationEnabled,
      idleThresholdMs: this.idleThresholdMs,
      pendingCleanup: {
        hibernationFailed,
        potentialOrphans,
        idleWorkspaces,
        gcFailed,
      },
    };
  }
}
