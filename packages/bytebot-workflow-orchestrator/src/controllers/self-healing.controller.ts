/**
 * Self-Healing Controller
 * v1.1.0: Added workspace health/reconciler status endpoints
 * v1.0.0: Phase 9 Self-Healing & Auto-Recovery
 *
 * REST API endpoints for self-healing features:
 * - Circuit breaker status and management
 * - Dead letter queue operations
 * - Workflow checkpoint and recovery
 * - Task recovery management
 * - Recovery logs and statistics
 * - Workspace health and reconciliation (v1.1.0)
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
  Logger,
} from '@nestjs/common';
import { CircuitBreakerService, CircuitBreakerStateEnum } from '../services/circuit-breaker.service';
import { DeadLetterQueueService, DLQStatus, DLQSeverity, FailureCategory } from '../services/dead-letter-queue.service';
import { WorkflowCheckpointService } from '../services/workflow-checkpoint.service';
import { TaskRecoveryService } from '../services/task-recovery.service';
import { PrismaService } from '../services/prisma.service';
import { WorkspaceDbReconcilerService } from '../services/workspace-db-reconciler.service';
import { OrphanPodGCService } from '../services/orphan-pod-gc.service';

// DTOs
class RetryDLQEntryDto {
  ids?: string[];
  id?: string;
}

class SkipDLQEntryDto {
  ids?: string[];
  id?: string;
  reason: string;
}

class DiscardDLQEntryDto {
  id: string;
  reason: string;
}

class RecoverWorkflowDto {
  workflowRunId: string;
  skipCompletedNodes?: boolean;
  resetFailedNodes?: boolean;
  fromCheckpoint?: string;
}

class ManualRecoverTaskDto {
  nodeRunId: string;
}

@Controller('recovery')
export class SelfHealingController {
  private readonly logger = new Logger(SelfHealingController.name);

  constructor(
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly dlq: DeadLetterQueueService,
    private readonly checkpoint: WorkflowCheckpointService,
    private readonly taskRecovery: TaskRecoveryService,
    private readonly prisma: PrismaService,
    private readonly workspaceReconciler: WorkspaceDbReconcilerService,
    private readonly orphanPodGC: OrphanPodGCService,
  ) {}

  // =========================================================================
  // Circuit Breaker Endpoints
  // =========================================================================

  /**
   * Get all circuit breaker statuses
   */
  @Get('circuits')
  async getCircuitBreakers() {
    const circuits = this.circuitBreaker.getAllStats();
    return {
      success: true,
      circuits,
      count: circuits.length,
    };
  }

  /**
   * Get circuit breaker status for a specific service
   */
  @Get('circuits/:serviceName')
  async getCircuitBreaker(@Param('serviceName') serviceName: string) {
    const stats = this.circuitBreaker.getStats(serviceName);
    if (!stats) {
      return {
        success: false,
        error: 'Circuit breaker not found',
      };
    }
    return {
      success: true,
      serviceName,
      ...stats,
    };
  }

  /**
   * Reset a circuit breaker
   */
  @Post('circuits/:serviceName/reset')
  @HttpCode(HttpStatus.OK)
  async resetCircuitBreaker(@Param('serviceName') serviceName: string) {
    await this.circuitBreaker.resetCircuit(serviceName);
    return {
      success: true,
      message: `Circuit breaker for ${serviceName} reset to CLOSED`,
    };
  }

  /**
   * Get circuit breaker history from database
   */
  @Get('circuits/:serviceName/history')
  async getCircuitBreakerHistory(
    @Param('serviceName') serviceName: string,
    @Query('limit') limit?: string,
  ) {
    const logs = await this.prisma.recoveryLog.findMany({
      where: {
        targetType: 'CIRCUIT_BREAKER',
        targetId: serviceName,
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit ?? '20', 10),
    });

    return {
      success: true,
      serviceName,
      history: logs,
    };
  }

  // =========================================================================
  // Dead Letter Queue Endpoints
  // =========================================================================

  /**
   * Get DLQ statistics
   */
  @Get('dlq/stats')
  async getDLQStats(@Query('tenantId') tenantId?: string) {
    const stats = await this.dlq.getStats(tenantId);
    return {
      success: true,
      stats,
    };
  }

  /**
   * Get DLQ entries
   */
  @Get('dlq/entries')
  async getDLQEntries(
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: DLQStatus,
    @Query('severity') severity?: DLQSeverity,
    @Query('category') category?: FailureCategory,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.dlq.getEntries({
      tenantId,
      status,
      severity,
      category,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return {
      success: true,
      entries: result.entries,
      total: result.total,
    };
  }

  /**
   * Get a single DLQ entry
   */
  @Get('dlq/entries/:id')
  async getDLQEntry(@Param('id') id: string) {
    const entry = await this.dlq.getEntry(id);
    if (!entry) {
      return {
        success: false,
        error: 'Entry not found',
      };
    }
    return {
      success: true,
      entry,
    };
  }

  /**
   * Retry a DLQ entry (or bulk retry)
   */
  @Post('dlq/retry')
  @HttpCode(HttpStatus.OK)
  async retryDLQEntry(@Body() dto: RetryDLQEntryDto) {
    if (dto.ids && dto.ids.length > 0) {
      const results = await this.dlq.bulkRetry(dto.ids);
      const successCount = results.filter((r) => r.success).length;
      return {
        success: true,
        message: `${successCount}/${dto.ids.length} entries queued for retry`,
        results,
      };
    }

    if (dto.id) {
      const result = await this.dlq.retryEntry(dto.id);
      return {
        success: result.success,
        result,
      };
    }

    return {
      success: false,
      error: 'Must provide id or ids',
    };
  }

  /**
   * Skip a DLQ entry (or bulk skip)
   */
  @Post('dlq/skip')
  @HttpCode(HttpStatus.OK)
  async skipDLQEntry(@Body() dto: SkipDLQEntryDto) {
    if (!dto.reason) {
      return {
        success: false,
        error: 'Reason is required',
      };
    }

    if (dto.ids && dto.ids.length > 0) {
      const results = await this.dlq.bulkSkip(dto.ids, dto.reason);
      const successCount = results.filter((r) => r.success).length;
      return {
        success: true,
        message: `${successCount}/${dto.ids.length} entries skipped`,
        results,
      };
    }

    if (dto.id) {
      const result = await this.dlq.skipEntry(dto.id, dto.reason);
      return {
        success: result.success,
        result,
      };
    }

    return {
      success: false,
      error: 'Must provide id or ids',
    };
  }

  /**
   * Discard a DLQ entry
   */
  @Post('dlq/discard')
  @HttpCode(HttpStatus.OK)
  async discardDLQEntry(@Body() dto: DiscardDLQEntryDto) {
    if (!dto.reason) {
      return {
        success: false,
        error: 'Reason is required',
      };
    }

    const result = await this.dlq.discardEntry(dto.id, dto.reason);
    return {
      success: result.success,
      result,
    };
  }

  // =========================================================================
  // Checkpoint Endpoints
  // =========================================================================

  /**
   * Get checkpoint statistics
   */
  @Get('checkpoints/stats')
  async getCheckpointStats() {
    const stats = await this.checkpoint.getCheckpointStats();
    return {
      success: true,
      stats,
    };
  }

  /**
   * Get checkpoints for a workflow
   */
  @Get('checkpoints/:workflowRunId')
  async getWorkflowCheckpoints(@Param('workflowRunId') workflowRunId: string) {
    const checkpoints = await this.checkpoint.getWorkflowCheckpoints(workflowRunId);
    return {
      success: true,
      workflowRunId,
      checkpoints,
      count: checkpoints.length,
    };
  }

  /**
   * Check if a workflow can be recovered
   */
  @Get('checkpoints/:workflowRunId/can-recover')
  async canRecoverWorkflow(@Param('workflowRunId') workflowRunId: string) {
    const result = await this.checkpoint.canRecover(workflowRunId);
    return {
      success: true,
      workflowRunId,
      ...result,
    };
  }

  /**
   * Recover a workflow from checkpoint
   */
  @Post('checkpoints/recover')
  @HttpCode(HttpStatus.OK)
  async recoverWorkflow(@Body() dto: RecoverWorkflowDto) {
    const result = await this.checkpoint.recoverWorkflow(dto.workflowRunId, {
      skipCompletedNodes: dto.skipCompletedNodes,
      resetFailedNodes: dto.resetFailedNodes,
      fromCheckpoint: dto.fromCheckpoint,
    });

    return {
      success: result.success,
      result,
    };
  }

  // =========================================================================
  // Task Recovery Endpoints
  // =========================================================================

  /**
   * Get task recovery statistics
   */
  @Get('tasks/stats')
  async getTaskRecoveryStats() {
    const stats = await this.taskRecovery.getRecoveryStats();
    return {
      success: true,
      stats,
    };
  }

  /**
   * Get stale tasks
   */
  @Get('tasks/stale')
  async getStaleTasks(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const where: any = {};
    if (status) {
      where.status = status;
    }

    const tasks = await this.prisma.staleTask.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: parseInt(limit ?? '50', 10),
    });

    return {
      success: true,
      tasks,
      count: tasks.length,
    };
  }

  /**
   * Manually trigger recovery for a task
   */
  @Post('tasks/recover')
  @HttpCode(HttpStatus.OK)
  async manualRecoverTask(@Body() dto: ManualRecoverTaskDto) {
    const result = await this.taskRecovery.manualRecover(dto.nodeRunId);
    return {
      success: result.success,
      result,
    };
  }

  /**
   * Trigger a full recovery check
   */
  @Post('tasks/check')
  @HttpCode(HttpStatus.OK)
  async triggerRecoveryCheck() {
    const summary = await this.taskRecovery.runRecoveryCheck();
    return {
      success: true,
      summary,
    };
  }

  // =========================================================================
  // Recovery Logs
  // =========================================================================

  /**
   * Get recovery logs
   */
  @Get('logs')
  async getRecoveryLogs(
    @Query('tenantId') tenantId?: string,
    @Query('actionType') actionType?: string,
    @Query('targetType') targetType?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const where: any = {};
    if (tenantId) where.tenantId = tenantId;
    if (actionType) where.actionType = actionType;
    if (targetType) where.targetType = targetType;

    const [logs, total] = await Promise.all([
      this.prisma.recoveryLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit ?? '50', 10),
        skip: parseInt(offset ?? '0', 10),
      }),
      this.prisma.recoveryLog.count({ where }),
    ]);

    return {
      success: true,
      logs,
      total,
    };
  }

  /**
   * Get recovery log summary
   */
  @Get('logs/summary')
  async getRecoveryLogSummary(@Query('tenantId') tenantId?: string) {
    const where: any = tenantId ? { tenantId } : {};
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [totalLogs, successfulLogs, recentLogs, byActionType] = await Promise.all([
      this.prisma.recoveryLog.count({ where }),
      this.prisma.recoveryLog.count({ where: { ...where, success: true } }),
      this.prisma.recoveryLog.count({
        where: { ...where, createdAt: { gte: oneDayAgo } },
      }),
      this.prisma.recoveryLog.groupBy({
        by: ['actionType'],
        where,
        _count: true,
      }),
    ]);

    return {
      success: true,
      summary: {
        totalLogs,
        successfulLogs,
        failedLogs: totalLogs - successfulLogs,
        successRate: totalLogs > 0 ? (successfulLogs / totalLogs) * 100 : 0,
        recentLogs24h: recentLogs,
        byActionType: byActionType.map((b) => ({
          actionType: b.actionType,
          count: b._count,
        })),
      },
    };
  }

  // =========================================================================
  // Health Summary
  // =========================================================================

  /**
   * Get overall self-healing health summary
   */
  @Get('health')
  async getSelfHealingHealth() {
    const [
      circuitStats,
      dlqStats,
      checkpointStats,
      taskRecoveryStats,
    ] = await Promise.all([
      Promise.resolve(this.circuitBreaker.getAllStats()),
      this.dlq.getStats(),
      this.checkpoint.getCheckpointStats(),
      this.taskRecovery.getRecoveryStats(),
    ]);

    // Determine overall health
    const openCircuits = circuitStats.filter(
      (c) => c.state === CircuitBreakerStateEnum.OPEN,
    ).length;

    const healthStatus =
      openCircuits > 0 || dlqStats.pending > 10 || taskRecoveryStats.pendingStaleTasks > 5
        ? 'DEGRADED'
        : 'HEALTHY';

    return {
      success: true,
      status: healthStatus,
      summary: {
        circuits: {
          total: circuitStats.length,
          open: openCircuits,
          halfOpen: circuitStats.filter(
            (c) => c.state === CircuitBreakerStateEnum.HALF_OPEN,
          ).length,
          closed: circuitStats.filter(
            (c) => c.state === CircuitBreakerStateEnum.CLOSED,
          ).length,
        },
        dlq: {
          pending: dlqStats.pending,
          retrying: dlqStats.retrying,
          criticalCount: dlqStats.bySeverity.critical,
        },
        checkpoints: {
          total: checkpointStats.totalCheckpoints,
          recoverable: checkpointStats.recoverableCheckpoints,
          expiringWithin24h: checkpointStats.expiringWithin24h,
        },
        taskRecovery: {
          pendingStaleTasks: taskRecoveryStats.pendingStaleTasks,
          recoveringTasks: taskRecoveryStats.recoveringTasks,
          recoveredLast24h: taskRecoveryStats.recoveredLast24h,
        },
      },
    };
  }

  // =========================================================================
  // Workspace Health & Reconciliation Endpoints (v1.1.0)
  // =========================================================================

  /**
   * Get workspace health overview
   * Shows K8s vs DB workspace state comparison and drift detection
   */
  @Get('workspaces/health')
  async getWorkspaceHealth() {
    const health = await this.workspaceReconciler.getWorkspaceHealth();
    return {
      success: true,
      ...health,
      summary: {
        k8sActiveCount: health.k8sWorkspaces.filter(
          (w) => w.phase === 'Running' || w.phase === 'Pending'
        ).length,
        dbActiveCount: health.dbActiveWorkspaces.length,
        driftDetectedCount: health.driftDetectedWorkspaces.length,
        hasDrift: health.driftDetectedWorkspaces.length > 0,
        capacityStatus: `${health.capacityUsed}/${health.maxCapacity} used`,
      },
    };
  }

  /**
   * Get workspace DB reconciler status
   */
  @Get('workspaces/reconciler')
  async getReconcilerStatus() {
    const status = await this.workspaceReconciler.getStatus();
    return {
      success: true,
      ...status,
    };
  }

  /**
   * Get orphan pod GC status
   */
  @Get('workspaces/gc')
  async getOrphanPodGCStatus() {
    const status = await this.orphanPodGC.getStatus();
    return {
      success: true,
      ...status,
    };
  }

  /**
   * Trigger manual workspace DB reconciliation
   */
  @Post('workspaces/reconcile')
  @HttpCode(HttpStatus.OK)
  async triggerReconcile() {
    this.logger.log('Manual workspace DB reconciliation triggered');
    const result = await this.workspaceReconciler.runReconcile();
    return {
      success: true,
      message: 'Reconciliation completed',
      result,
    };
  }

  /**
   * Trigger manual orphan pod GC
   */
  @Post('workspaces/gc')
  @HttpCode(HttpStatus.OK)
  async triggerOrphanGC() {
    this.logger.log('Manual orphan pod GC triggered');
    const result = await this.orphanPodGC.runGC();
    return {
      success: true,
      message: 'Orphan GC completed',
      result,
    };
  }
}
