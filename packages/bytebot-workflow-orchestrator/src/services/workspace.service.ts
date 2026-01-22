/**
 * Workspace Service
 * v1.0.1: Fixed storage class to use task-controller's configured default
 * v1.0.0: Manages workspace lifecycle via task-controller API
 *
 * This service acts as a client to the task-controller's workspace endpoints.
 * It handles:
 * - Creating persistent desktops
 * - Checking desktop status
 * - Hibernating and terminating workspaces
 * - Acquiring and releasing workspace locks
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from './prisma.service';

export interface WorkspaceDesktopStatus {
  workspaceId: string;
  status: 'CREATING' | 'READY' | 'NOT_FOUND' | 'ERROR' | 'TERMINATED' | 'HIBERNATED';
  desktopEndpoint: string | null;
  vncEndpoint: string | null;
  pvcName: string | null;
  podName: string | null;
  podIP: string | null;
  podPhase: string | null;
  message?: string;
}

export interface PersistenceConfig {
  enabled?: boolean;
  storageClass?: string;
  size?: string;
  mounts?: Array<{ mountPath: string; subPath: string }>;
  retainOnDelete?: boolean;
}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly taskControllerClient: AxiosInstance;
  private readonly internalToken: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const taskControllerUrl = this.configService.get<string>(
      'TASK_CONTROLLER_URL',
      'http://bytebot-task-controller:8080',
    );

    this.internalToken = this.configService.get<string>(
      'INTERNAL_SERVICE_TOKEN',
      '',
    );

    this.taskControllerClient = axios.create({
      baseURL: taskControllerUrl,
      timeout: 120000, // 2 minutes for workspace creation
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': this.internalToken,
        'X-Service-Id': 'bytebot-workflow-orchestrator',
      },
    });

    if (!this.internalToken) {
      this.logger.warn(
        'INTERNAL_SERVICE_TOKEN not configured - workspace API calls may fail',
      );
    }
  }

  /**
   * Create or ensure a workspace desktop exists
   *
   * Calls the task-controller's POST /api/v1/workspaces/:workspaceId/desktop endpoint
   */
  async ensureWorkspaceDesktop(
    workspaceId: string,
    tenantId: string,
    persistence?: PersistenceConfig,
  ): Promise<WorkspaceDesktopStatus> {
    this.logger.log(`Ensuring workspace desktop: ${workspaceId}`);

    try {
      const response = await this.taskControllerClient.post(
        `/api/v1/workspaces/${workspaceId}/desktop`,
        {
          tenantId,
          persistence: {
            enabled: persistence?.enabled ?? true,
            // Let task-controller use its configured default storage class
            // (WORKSPACE_DEFAULT_STORAGE_CLASS env var) when not explicitly specified
            storageClass: persistence?.storageClass,
            size: persistence?.size || '10Gi',
            mounts: persistence?.mounts,
            retainOnDelete: persistence?.retainOnDelete ?? true,
          },
        },
      );

      this.logger.log(
        `Workspace ${workspaceId} desktop: ${response.data.status}`,
      );

      return response.data;
    } catch (error: any) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Failed to ensure workspace desktop: ${message}`);
      throw new Error(`Workspace desktop creation failed: ${message}`);
    }
  }

  /**
   * Get workspace desktop status
   */
  async getWorkspaceDesktopStatus(
    workspaceId: string,
  ): Promise<WorkspaceDesktopStatus> {
    try {
      const response = await this.taskControllerClient.get(
        `/api/v1/workspaces/${workspaceId}/desktop`,
      );
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return {
          workspaceId,
          status: 'NOT_FOUND',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: null,
          podName: null,
          podIP: null,
          podPhase: null,
        };
      }
      throw error;
    }
  }

  /**
   * Wait for workspace desktop to be ready
   */
  async waitForWorkspaceReady(
    workspaceId: string,
    timeoutMs: number = 120000,
  ): Promise<WorkspaceDesktopStatus> {
    try {
      const response = await this.taskControllerClient.get(
        `/api/v1/workspaces/${workspaceId}/desktop/wait`,
        { params: { timeoutMs } },
      );
      return response.data;
    } catch (error: any) {
      const message = error.response?.data?.message || error.message;
      throw new Error(`Wait for workspace failed: ${message}`);
    }
  }

  /**
   * Hibernate workspace (delete pod, keep PVC)
   */
  async hibernateWorkspace(workspaceId: string): Promise<WorkspaceDesktopStatus> {
    this.logger.log(`Hibernating workspace: ${workspaceId}`);

    try {
      const response = await this.taskControllerClient.post(
        `/api/v1/workspaces/${workspaceId}/desktop/hibernate`,
      );

      this.logger.log(`Workspace ${workspaceId} hibernated`);
      return response.data;
    } catch (error: any) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Failed to hibernate workspace: ${message}`);
      throw new Error(`Workspace hibernation failed: ${message}`);
    }
  }

  /**
   * Terminate workspace (delete pod and PVC)
   */
  async terminateWorkspace(
    workspaceId: string,
    deletePVC: boolean = true,
  ): Promise<WorkspaceDesktopStatus> {
    this.logger.log(`Terminating workspace: ${workspaceId} (deletePVC=${deletePVC})`);

    try {
      const response = await this.taskControllerClient.post(
        `/api/v1/workspaces/${workspaceId}/desktop/terminate`,
        { deletePVC },
      );

      this.logger.log(`Workspace ${workspaceId} terminated`);
      return response.data;
    } catch (error: any) {
      const message = error.response?.data?.message || error.message;
      this.logger.error(`Failed to terminate workspace: ${message}`);
      throw new Error(`Workspace termination failed: ${message}`);
    }
  }

  /**
   * v2.3.0 M4: Acquire granular workspace lock for desktop tool execution
   * Lock is held only during active desktop tool execution (30-60 seconds)
   * Uses atomic update with expiry check for safe concurrent access
   *
   * @param workspaceId - Workspace to lock
   * @param nodeRunId - ID of the node run acquiring the lock
   * @param leaseSeconds - Lock duration in seconds (default 30 seconds)
   * @returns Lock acquisition result with expiry time
   */
  async acquireLock(
    workspaceId: string,
    nodeRunId: string,
    leaseSeconds: number = 30,
  ): Promise<{
    acquired: boolean;
    lockExpiresAt?: string;
    message: string;
    retryAfterMs?: number;
    currentOwner?: string;
  }> {
    const lockExpiry = new Date(Date.now() + leaseSeconds * 1000);

    try {
      // Use raw query for atomic locking with expiry check
      const result = await this.prisma.$executeRaw`
        UPDATE workspaces
        SET lock_owner_node_run_id = ${nodeRunId},
            lock_acquired_at = NOW(),
            lock_expires_at = ${lockExpiry}
        WHERE id = ${workspaceId}
          AND (
            lock_owner_node_run_id IS NULL
            OR lock_owner_node_run_id = ${nodeRunId}
            OR lock_expires_at < NOW()
          )
      `;

      if (result === 0) {
        // Lock acquisition failed - get current owner info
        const workspace = await this.prisma.workspace.findUnique({
          where: { id: workspaceId },
          select: { lockOwnerNodeRunId: true, lockExpiresAt: true },
        });

        const remainingMs = workspace?.lockExpiresAt
          ? Math.max(0, workspace.lockExpiresAt.getTime() - Date.now())
          : 5000;

        this.logger.debug(
          `Lock contention on workspace ${workspaceId}: owned by ${workspace?.lockOwnerNodeRunId}, expires in ${remainingMs}ms`,
        );

        return {
          acquired: false,
          message: `Lock held by another node run: ${workspace?.lockOwnerNodeRunId}`,
          currentOwner: workspace?.lockOwnerNodeRunId || undefined,
          retryAfterMs: Math.min(remainingMs + 1000, 10000), // Add 1 second buffer, cap at 10s
        };
      }

      this.logger.log(
        `Lock acquired on workspace ${workspaceId} by nodeRun ${nodeRunId}, expires at ${lockExpiry.toISOString()}`,
      );

      return {
        acquired: true,
        lockExpiresAt: lockExpiry.toISOString(),
        message: 'Lock acquired',
      };
    } catch (error: any) {
      this.logger.error(
        `Error acquiring workspace lock: ${error.message}`,
      );
      return {
        acquired: false,
        message: `Lock acquisition error: ${error.message}`,
        retryAfterMs: 5000,
      };
    }
  }

  /**
   * v2.3.0 M4: Renew workspace lock
   */
  async renewLock(
    workspaceId: string,
    nodeRunId: string,
    leaseSeconds: number = 30,
  ): Promise<{
    renewed: boolean;
    lockExpiresAt?: string;
    message: string;
  }> {
    const newExpiry = new Date(Date.now() + leaseSeconds * 1000);

    const result = await this.prisma.workspace.updateMany({
      where: {
        id: workspaceId,
        lockOwnerNodeRunId: nodeRunId,
      },
      data: {
        lockExpiresAt: newExpiry,
      },
    });

    if (result.count === 0) {
      this.logger.warn(`Failed to renew lock for workspace ${workspaceId} - not owned by ${nodeRunId}`);
      return {
        renewed: false,
        message: 'Lock not owned by this node run',
      };
    }

    this.logger.debug(
      `Lock renewed on workspace ${workspaceId} by nodeRun ${nodeRunId}, new expiry ${newExpiry.toISOString()}`,
    );

    return {
      renewed: true,
      lockExpiresAt: newExpiry.toISOString(),
      message: 'Lock renewed',
    };
  }

  /**
   * v2.3.0 M4: Release workspace lock
   */
  async releaseLock(
    workspaceId: string,
    nodeRunId: string,
  ): Promise<{
    released: boolean;
    message: string;
  }> {
    const result = await this.prisma.workspace.updateMany({
      where: {
        id: workspaceId,
        lockOwnerNodeRunId: nodeRunId,
      },
      data: {
        lockOwnerNodeRunId: null,
        lockAcquiredAt: null,
        lockExpiresAt: null,
      },
    });

    if (result.count === 0) {
      this.logger.debug(`Lock on workspace ${workspaceId} not owned by ${nodeRunId}, nothing to release`);
      return {
        released: false,
        message: 'Lock not owned by this node run',
      };
    }

    this.logger.log(`Lock released on workspace ${workspaceId} by nodeRun ${nodeRunId}`);
    return {
      released: true,
      message: 'Lock released',
    };
  }

  /**
   * Get current lock status for a workspace
   */
  async getLockStatus(workspaceId: string): Promise<{
    locked: boolean;
    ownerNodeRunId: string | null;
    expiresAt: string | null;
  }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { lockOwnerNodeRunId: true, lockExpiresAt: true },
    });

    if (!workspace) {
      return { locked: false, ownerNodeRunId: null, expiresAt: null };
    }

    // Check if lock has expired
    const isExpired = workspace.lockExpiresAt
      ? workspace.lockExpiresAt < new Date()
      : true;

    return {
      locked: !!workspace.lockOwnerNodeRunId && !isExpired,
      ownerNodeRunId: isExpired ? null : workspace.lockOwnerNodeRunId,
      expiresAt: isExpired ? null : workspace.lockExpiresAt?.toISOString() || null,
    };
  }
}
