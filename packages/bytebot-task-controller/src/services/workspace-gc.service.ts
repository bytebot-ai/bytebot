/**
 * Workspace Garbage Collection Service
 * v1.0.16: Added retain/pin escape hatch (bytebot.ai/retain=true label)
 * v1.0.15: Cleans up hibernated workspaces that exceed TTL
 *
 * This service runs on a schedule to prevent storage sprawl from
 * orphaned or long-hibernated workspace PVCs.
 *
 * Configuration:
 * - WORKSPACE_HIBERNATE_TTL_HOURS: Hours before hibernated workspace is eligible for cleanup (default: 48)
 * - WORKSPACE_GC_INTERVAL_MINUTES: How often to run GC (default: 60 minutes)
 * - WORKSPACE_GC_ENABLED: Enable/disable GC (default: true)
 *
 * Escape Hatch:
 * - Label PVC with bytebot.ai/retain=true to prevent automatic deletion
 * - Useful for forensic debugging or long-running investigations
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KubernetesService } from './kubernetes.service';
import * as k8s from '@kubernetes/client-node';

interface GCStats {
  scanned: number;
  expired: number;
  deleted: number;
  retained: number;  // v1.0.16: PVCs skipped due to retain label
  errors: number;
}

@Injectable()
export class WorkspaceGCService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceGCService.name);
  private readonly enabled: boolean;
  private readonly ttlHours: number;
  private readonly namespace: string;
  private coreApi: k8s.CoreV1Api;
  private kubeConfig: k8s.KubeConfig;

  constructor(
    private configService: ConfigService,
    private k8sService: KubernetesService,
  ) {
    this.enabled = this.configService.get<string>('WORKSPACE_GC_ENABLED', 'true') === 'true';
    // v1.0.16: Changed default from 168h (7 days) to 48h (2 days)
    // Rationale: 14 PVC/day growth rate → 48h caps at ~28 PVCs (280Gi) vs ~98 PVCs (980Gi)
    this.ttlHours = parseInt(
      this.configService.get<string>('WORKSPACE_HIBERNATE_TTL_HOURS', '48'),
      10,
    );
    this.namespace = this.configService.get<string>('KUBERNETES_NAMESPACE', 'bytebot');
  }

  async onModuleInit() {
    // Initialize Kubernetes client
    this.kubeConfig = new k8s.KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);

    if (this.enabled) {
      this.logger.log(
        `Workspace GC enabled: TTL=${this.ttlHours}h, namespace=${this.namespace}`,
      );
    } else {
      this.logger.warn('Workspace GC is disabled');
    }
  }

  /**
   * Run GC every hour (configurable via cron)
   * Only runs if the instance is the leader (handled by leader election in reconciler)
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runScheduledGC(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    this.logger.log('Starting scheduled workspace GC');
    try {
      const stats = await this.cleanupExpiredWorkspaces();
      this.logger.log(
        `Workspace GC complete: scanned=${stats.scanned}, expired=${stats.expired}, ` +
        `deleted=${stats.deleted}, retained=${stats.retained}, errors=${stats.errors}`,
      );
    } catch (error: any) {
      this.logger.error(`Workspace GC failed: ${error.message}`);
    }
  }

  /**
   * Manual trigger for GC (e.g., via API endpoint)
   */
  async runManualGC(): Promise<GCStats> {
    this.logger.log('Starting manual workspace GC');
    return this.cleanupExpiredWorkspaces();
  }

  /**
   * Main GC logic: Find and delete expired hibernated workspace PVCs
   */
  private async cleanupExpiredWorkspaces(): Promise<GCStats> {
    const stats: GCStats = {
      scanned: 0,
      expired: 0,
      deleted: 0,
      retained: 0,
      errors: 0,
    };

    try {
      // List all workspace PVCs
      const response = await this.coreApi.listNamespacedPersistentVolumeClaim(
        this.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'bytebot.ai/component=workspace-storage',
      );

      const pvcs = response.body.items;
      stats.scanned = pvcs.length;

      const now = Date.now();
      const ttlMs = this.ttlHours * 60 * 60 * 1000;

      for (const pvc of pvcs) {
        const workspaceId = pvc.metadata?.labels?.['bytebot.ai/workspace-id'];
        if (!workspaceId) {
          continue;
        }

        // Check if workspace is hibernated (no pod exists)
        const pod = await this.k8sService.getWorkspacePod(workspaceId, this.namespace);
        if (pod) {
          // Workspace is active, skip
          continue;
        }

        // Get hibernation timestamp
        const hibernatedAt = this.getHibernationTime(pvc);
        if (!hibernatedAt) {
          // No hibernation time recorded, use created time as fallback
          const createdAt = pvc.metadata?.creationTimestamp;
          if (!createdAt) {
            continue;
          }
        }

        const hibernationTime = hibernatedAt || new Date(pvc.metadata?.creationTimestamp || 0).getTime();
        const age = now - hibernationTime;

        if (age > ttlMs) {
          stats.expired++;

          // v1.0.16: Check for retain/pin escape hatch
          const retainLabel = pvc.metadata?.labels?.['bytebot.ai/retain'];
          if (retainLabel === 'true') {
            stats.retained++;
            this.logger.log(
              `Workspace ${workspaceId} expired but retained (bytebot.ai/retain=true, age=${Math.round(age / 3600000)}h)`,
            );
            continue;
          }

          this.logger.log(
            `Workspace ${workspaceId} exceeded TTL (age=${Math.round(age / 3600000)}h, ttl=${this.ttlHours}h)`,
          );

          try {
            // Force delete the PVC
            await this.coreApi.deleteNamespacedPersistentVolumeClaim(
              pvc.metadata?.name || '',
              this.namespace,
            );
            stats.deleted++;
            this.logger.log(`Deleted expired workspace PVC: ${pvc.metadata?.name}`);
          } catch (deleteError: any) {
            if (deleteError.statusCode !== 404) {
              stats.errors++;
              this.logger.error(
                `Failed to delete workspace PVC ${pvc.metadata?.name}: ${deleteError.message}`,
              );
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error listing workspace PVCs: ${error.message}`);
      stats.errors++;
    }

    return stats;
  }

  /**
   * Get hibernation timestamp from PVC annotations
   */
  private getHibernationTime(pvc: k8s.V1PersistentVolumeClaim): number | null {
    const hibernatedAtStr = pvc.metadata?.annotations?.['bytebot.ai/hibernated-at'];
    if (!hibernatedAtStr) {
      return null;
    }

    const timestamp = new Date(hibernatedAtStr).getTime();
    if (isNaN(timestamp)) {
      return null;
    }

    return timestamp;
  }

  /**
   * Mark a PVC as hibernated (called when pod is deleted)
   */
  async markWorkspaceHibernated(workspaceId: string): Promise<void> {
    try {
      const pvc = await this.k8sService.getWorkspacePVC(workspaceId, this.namespace);
      if (!pvc || !pvc.metadata?.name) {
        return;
      }

      // Patch the PVC with hibernation timestamp
      await this.coreApi.patchNamespacedPersistentVolumeClaim(
        pvc.metadata.name,
        this.namespace,
        {
          metadata: {
            annotations: {
              'bytebot.ai/hibernated-at': new Date().toISOString(),
            },
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        },
      );

      this.logger.debug(`Marked workspace ${workspaceId} as hibernated`);
    } catch (error: any) {
      this.logger.warn(`Failed to mark workspace ${workspaceId} as hibernated: ${error.message}`);
    }
  }

  /**
   * Clear hibernation marker when workspace is awakened
   */
  async clearWorkspaceHibernation(workspaceId: string): Promise<void> {
    try {
      const pvc = await this.k8sService.getWorkspacePVC(workspaceId, this.namespace);
      if (!pvc || !pvc.metadata?.name) {
        return;
      }

      // Remove hibernation annotation
      await this.coreApi.patchNamespacedPersistentVolumeClaim(
        pvc.metadata.name,
        this.namespace,
        {
          metadata: {
            annotations: {
              'bytebot.ai/hibernated-at': null,
            },
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: { 'Content-Type': 'application/merge-patch+json' },
        },
      );

      this.logger.debug(`Cleared hibernation marker for workspace ${workspaceId}`);
    } catch (error: any) {
      this.logger.warn(`Failed to clear hibernation for workspace ${workspaceId}: ${error.message}`);
    }
  }
}
