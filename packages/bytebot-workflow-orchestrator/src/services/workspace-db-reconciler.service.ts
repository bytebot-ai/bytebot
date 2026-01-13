/**
 * Workspace DB Reconciler Service
 * v1.0.0: Detects and reconciles DB/K8s workspace state drift
 *
 * This service runs on a schedule to find DB workspace records that claim
 * to be active (READY/CREATING) but have no corresponding K8s pod.
 *
 * State drift can occur when:
 * - Pod was deleted manually (kubectl delete)
 * - Node failure caused pod eviction without proper hibernation
 * - Network partition during hibernation caused DB update failure
 * - Task-controller deleted pod but orchestrator missed webhook
 *
 * Two-pass safety pattern:
 * 1. First pass: Mark workspace as DRIFT_DETECTED
 * 2. Second pass (5 min later): If still DRIFT_DETECTED, transition to HIBERNATED
 *
 * This prevents race conditions where a pod is being created but not yet visible.
 *
 * @see OrphanPodGCService for the inverse problem (K8s pods without DB records)
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from './prisma.service';

export interface ReconcileResult {
  checked: number;
  driftDetected: number;
  reconciled: number;
  errors: string[];
}

export interface WorkspacePodInfo {
  workspaceId: string;
  podName: string;
  phase: string;
  nodeName: string;
}

@Injectable()
export class WorkspaceDbReconcilerService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceDbReconcilerService.name);
  private isRunning = false;
  private lastReconcileAt: Date | null = null;

  // K8s client
  private k8sApi: k8s.CoreV1Api;

  // Namespace for workspace pods
  private readonly namespace: string;

  // Grace period before considering a workspace as drifted
  // Default: 10 minutes (allows for slow pod creation)
  private readonly gracePeriodMs: number;

  // Whether reconciler is enabled
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.namespace = this.configService.get<string>(
      'KUBERNETES_NAMESPACE',
      'bytebot',
    );
    this.gracePeriodMs = this.configService.get<number>(
      'RECONCILER_GRACE_PERIOD_MS',
      10 * 60 * 1000, // 10 minutes
    );
    this.enabled = this.configService.get<boolean>(
      'WORKSPACE_DB_RECONCILER_ENABLED',
      true,
    );

    // Initialize K8s client
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  onModuleInit() {
    this.logger.log(
      `WorkspaceDbReconcilerService initialized (enabled=${this.enabled}, ` +
      `namespace=${this.namespace}, gracePeriod=${this.gracePeriodMs}ms)`,
    );
  }

  /**
   * Run reconciliation every 5 minutes
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runScheduledReconcile(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (this.isRunning) {
      this.logger.debug('Workspace DB reconciler already running, skipping');
      return;
    }

    await this.runReconcile();
  }

  /**
   * Run workspace DB reconciliation
   * Can be called manually or via cron
   */
  async runReconcile(): Promise<ReconcileResult> {
    this.isRunning = true;
    const result: ReconcileResult = {
      checked: 0,
      driftDetected: 0,
      reconciled: 0,
      errors: [],
    };

    try {
      this.logger.debug('Starting workspace DB reconcile cycle');

      // Phase 1: Get all workspace pods from K8s (source of truth)
      const k8sPods = await this.listWorkspacePods();
      const k8sWorkspaceIds = new Set(k8sPods.map(p => p.workspaceId));

      this.logger.debug(
        `Found ${k8sPods.length} workspace pods in K8s: ${Array.from(k8sWorkspaceIds).join(', ')}`,
      );

      // Phase 2: Find DB records claiming to be active
      const gracePeriodAgo = new Date(Date.now() - this.gracePeriodMs);
      const activeDbWorkspaces = await this.prisma.workspace.findMany({
        where: {
          status: { in: ['READY', 'CREATING'] },
          // Only consider workspaces that have been in this state for a while
          updatedAt: { lt: gracePeriodAgo },
        },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          createdAt: true,
        },
        take: 100, // Process in batches
      });

      result.checked = activeDbWorkspaces.length;

      // Phase 3: Detect drift - DB says active but no K8s pod
      for (const workspace of activeDbWorkspaces) {
        if (k8sWorkspaceIds.has(workspace.id)) {
          // Pod exists - no drift
          continue;
        }

        // Pod doesn't exist - this is drift
        this.logger.warn(
          `Drift detected: workspace ${workspace.id} is ${workspace.status} in DB ` +
          `but has no K8s pod (last updated: ${workspace.updatedAt.toISOString()})`,
        );

        try {
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              status: 'DRIFT_DETECTED',
              hibernationError: `No K8s pod found. Was ${workspace.status} since ${workspace.updatedAt.toISOString()}`,
            },
          });
          result.driftDetected++;
        } catch (error: any) {
          result.errors.push(`${workspace.id}: ${error.message}`);
        }
      }

      // Phase 4: Second pass - reconcile DRIFT_DETECTED workspaces
      // These were marked in a PREVIOUS cycle, so they've had 5+ minutes to recover
      const driftedWorkspaces = await this.prisma.workspace.findMany({
        where: {
          status: 'DRIFT_DETECTED',
          // Must have been marked drift at least 5 minutes ago (previous cycle)
          updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
        },
        select: {
          id: true,
          hibernationError: true,
        },
        take: 50,
      });

      for (const workspace of driftedWorkspaces) {
        // Double-check pod still doesn't exist
        if (k8sWorkspaceIds.has(workspace.id)) {
          // Pod appeared! Clear drift status
          this.logger.log(
            `Drift cleared: workspace ${workspace.id} pod recovered`,
          );
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              status: 'READY',
              hibernationError: null,
            },
          });
          continue;
        }

        // Still no pod after grace period - reconcile to HIBERNATED
        try {
          await this.prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              status: 'HIBERNATED',
              hibernationError: null,
            },
          });
          this.logger.log(
            `Reconciled: workspace ${workspace.id} transitioned DRIFT_DETECTED → HIBERNATED`,
          );
          result.reconciled++;
        } catch (error: any) {
          result.errors.push(`${workspace.id}: ${error.message}`);
        }
      }

      // Update last reconcile timestamp
      this.lastReconcileAt = new Date();

      if (result.checked > 0 || result.driftDetected > 0 || result.reconciled > 0) {
        this.logger.log(
          `Reconcile complete: checked=${result.checked}, ` +
          `driftDetected=${result.driftDetected}, reconciled=${result.reconciled}`,
        );
      }

      // Emit metrics event
      this.eventEmitter.emit('workspace-db-reconcile.completed', {
        timestamp: new Date(),
        ...result,
      });

      return result;
    } catch (error: any) {
      this.logger.error(`Workspace DB reconcile failed: ${error.message}`);
      result.errors.push(error.message);
      return result;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * List all workspace pods in K8s
   * Uses label selector: bytebot.ai/component=desktop-workspace
   */
  private async listWorkspacePods(): Promise<WorkspacePodInfo[]> {
    try {
      const response = await this.k8sApi.listNamespacedPod(
        this.namespace,
        undefined, // pretty
        undefined, // allowWatchBookmarks
        undefined, // _continue
        undefined, // fieldSelector
        'bytebot.ai/component=workspace-desktop', // labelSelector
      );

      return response.body.items
        .filter((pod: k8s.V1Pod) => {
          // Extract workspace ID from pod name (format: desktop-ws-{workspaceId})
          const match = pod.metadata?.name?.match(/^desktop-ws-(.+)$/);
          return match && match[1];
        })
        .map((pod: k8s.V1Pod) => {
          const match = pod.metadata!.name!.match(/^desktop-ws-(.+)$/);
          return {
            workspaceId: `ws-${match![1]}`,
            podName: pod.metadata!.name!,
            phase: pod.status?.phase || 'Unknown',
            nodeName: pod.spec?.nodeName || 'Unknown',
          };
        });
    } catch (error: any) {
      this.logger.error(`Failed to list workspace pods: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get active workspace count from K8s (source of truth)
   * Used by checkCapacity() for hardened capacity logic
   */
  async getK8sActiveWorkspaceCount(): Promise<number> {
    const pods = await this.listWorkspacePods();
    // Only count Running/Pending pods (not Succeeded/Failed/Unknown)
    return pods.filter(p =>
      p.phase === 'Running' || p.phase === 'Pending'
    ).length;
  }

  /**
   * Get current reconciler status and stats
   */
  async getStatus(): Promise<{
    enabled: boolean;
    isRunning: boolean;
    lastReconcileAt: string | null;
    gracePeriodMs: number;
    namespace: string;
    health: {
      k8sPodCount: number;
      dbActiveCount: number;
      driftDetectedCount: number;
      isHealthy: boolean;
      staleSinceMs: number | null;
    };
  }> {
    let k8sPodCount = 0;
    try {
      const pods = await this.listWorkspacePods();
      k8sPodCount = pods.filter(p =>
        p.phase === 'Running' || p.phase === 'Pending'
      ).length;
    } catch {
      // K8s unreachable
    }

    const [dbActiveCount, driftDetectedCount] = await Promise.all([
      this.prisma.workspace.count({
        where: { status: { in: ['READY', 'CREATING'] } },
      }),
      this.prisma.workspace.count({
        where: { status: 'DRIFT_DETECTED' },
      }),
    ]);

    // Calculate staleness
    const staleSinceMs = this.lastReconcileAt
      ? Date.now() - this.lastReconcileAt.getTime()
      : null;

    // Health check: reconcile not stale (< 15 min) and no drift detected
    const isHealthy =
      staleSinceMs !== null &&
      staleSinceMs < 15 * 60 * 1000 &&
      driftDetectedCount === 0;

    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      lastReconcileAt: this.lastReconcileAt?.toISOString() || null,
      gracePeriodMs: this.gracePeriodMs,
      namespace: this.namespace,
      health: {
        k8sPodCount,
        dbActiveCount,
        driftDetectedCount,
        isHealthy,
        staleSinceMs,
      },
    };
  }

  /**
   * Get workspace health comparison between K8s and DB
   * For admin/ops visibility (Phase 3)
   */
  async getWorkspaceHealth(): Promise<{
    k8sWorkspaces: WorkspacePodInfo[];
    dbActiveWorkspaces: { id: string; status: string; updatedAt: Date }[];
    driftDetectedWorkspaces: { id: string; hibernationError: string | null; updatedAt: Date }[];
    capacityUsed: number;
    capacityRemaining: number;
    maxCapacity: number;
  }> {
    const maxCapacity = parseInt(
      this.configService.get<string>('MAX_ACTIVE_WORKSPACES_GLOBAL', '6'),
      10,
    );

    const [k8sWorkspaces, dbActiveWorkspaces, driftDetectedWorkspaces] = await Promise.all([
      this.listWorkspacePods().catch(() => []),
      this.prisma.workspace.findMany({
        where: { status: { in: ['READY', 'CREATING'] } },
        select: { id: true, status: true, updatedAt: true },
      }),
      this.prisma.workspace.findMany({
        where: { status: 'DRIFT_DETECTED' },
        select: { id: true, hibernationError: true, updatedAt: true },
      }),
    ]);

    const capacityUsed = k8sWorkspaces.filter(p =>
      p.phase === 'Running' || p.phase === 'Pending'
    ).length;

    return {
      k8sWorkspaces,
      dbActiveWorkspaces,
      driftDetectedWorkspaces,
      capacityUsed,
      capacityRemaining: Math.max(0, maxCapacity - capacityUsed),
      maxCapacity,
    };
  }
}
