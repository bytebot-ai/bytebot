/**
 * Workspace Controller API
 * v1.0.15: Workspace lifecycle management for persistent desktop sessions
 *
 * Provides endpoints for managing workspace persistence (PVC + Pod lifecycle)
 * for the workflow orchestration system. Workspaces provide "one continuing
 * computer" experience where browser sessions, downloads, and working files
 * persist across task executions.
 *
 * Endpoints:
 * - POST /workspaces/:workspaceId/desktop          Create or ensure desktop exists (idempotent)
 * - GET  /workspaces/:workspaceId/desktop          Get status/endpoint
 * - POST /workspaces/:workspaceId/desktop/terminate Delete pod + optionally PVC
 * - POST /workspaces/:workspaceId/desktop/hibernate Delete pod, keep PVC (future resume)
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { KubernetesService } from '../services/kubernetes.service';
import { MetricsService } from '../services/metrics.service';
import { WorkspaceGCService } from '../services/workspace-gc.service';
import {
  PersistenceConfig,
  PersistenceMount,
  DEFAULT_PERSISTENCE_MOUNTS,
} from '../interfaces/taskdesktop.interface';
import { validateWorkspaceId, toWorkspacePodName } from '../utils/dns-naming.util';

/**
 * Request body for creating a workspace desktop
 */
interface CreateWorkspaceDesktopRequest {
  tenantId: string;
  persistence?: {
    enabled?: boolean;
    storageClass?: string;
    size?: string;
    mounts?: PersistenceMount[];
    retainOnDelete?: boolean;
  };
}

/**
 * Response for workspace desktop operations
 */
interface WorkspaceDesktopResponse {
  workspaceId: string;
  status: 'CREATING' | 'READY' | 'NOT_FOUND' | 'ERROR' | 'TERMINATED' | 'HIBERNATED';
  desktopEndpoint: string | null;
  vncEndpoint: string | null;
  pvcName: string | null;
  podName: string | null;
  podIP: string | null;
  podPhase: string | null;
  message?: string;
  createdAt?: string;
}

/**
 * Request body for terminate operation
 */
interface TerminateWorkspaceRequest {
  deletePVC?: boolean;  // Default: false (hibernate behavior)
}

@Controller('api/v1/workspaces')
@UseGuards(InternalAuthGuard)
export class WorkspaceController {
  private readonly logger = new Logger(WorkspaceController.name);

  // Default persistence configuration
  private readonly defaultPersistenceConfig: PersistenceConfig = {
    enabled: true,
    storageClass: process.env.WORKSPACE_DEFAULT_STORAGE_CLASS || 'longhorn',
    size: process.env.WORKSPACE_DEFAULT_SIZE || '10Gi',
    mounts: DEFAULT_PERSISTENCE_MOUNTS,
    retainOnDelete: process.env.WORKSPACE_RETAIN_ON_DELETE === 'true',
  };

  constructor(
    private k8sService: KubernetesService,
    private metricsService: MetricsService,
    private gcService: WorkspaceGCService,
  ) {}

  /**
   * POST /api/v1/workspaces/:workspaceId/desktop
   *
   * Create or ensure a workspace desktop exists (idempotent).
   * This is the primary endpoint for workflow orchestration to request
   * a persistent desktop for a workflow run.
   *
   * The operation:
   * 1. Creates PVC if not exists
   * 2. Creates Pod with PVC mounts if not exists
   * 3. Waits for Pod to be ready
   * 4. Returns desktop endpoint
   *
   * Idempotent: Multiple calls with the same workspaceId return the same desktop.
   */
  @Post(':workspaceId/desktop')
  async createOrEnsureDesktop(
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateWorkspaceDesktopRequest,
  ): Promise<WorkspaceDesktopResponse> {
    this.logger.log(`Create/ensure workspace desktop: ${workspaceId}`);

    // v1.0.15: Validate workspaceId with DNS-1123 constraints
    const validation = validateWorkspaceId(workspaceId);
    if (!validation.valid) {
      throw new HttpException(
        `Invalid workspaceId: ${validation.error}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.tenantId) {
      throw new HttpException(
        'tenantId is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Build persistence config from request + defaults
    const persistenceConfig: PersistenceConfig = {
      enabled: body.persistence?.enabled ?? this.defaultPersistenceConfig.enabled,
      storageClass: body.persistence?.storageClass ?? this.defaultPersistenceConfig.storageClass,
      size: body.persistence?.size ?? this.defaultPersistenceConfig.size,
      mounts: body.persistence?.mounts ?? this.defaultPersistenceConfig.mounts,
      retainOnDelete: body.persistence?.retainOnDelete ?? this.defaultPersistenceConfig.retainOnDelete,
    };

    try {
      // Use the idempotent ensureWorkspace method
      const result = await this.k8sService.ensureWorkspace(
        workspaceId,
        body.tenantId,
        persistenceConfig,
        true, // Wait for ready
      );

      if (!result.success) {
        this.logger.error(`Failed to create workspace ${workspaceId}: ${result.error}`);
        return {
          workspaceId,
          status: 'ERROR',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: result.pvcName || null,
          podName: result.podName || null,
          podIP: null,
          podPhase: null,
          message: result.error,
        };
      }

      this.logger.log(`Workspace ${workspaceId} ready at ${result.desktopEndpoint}`);

      // Clear hibernation marker if this was a wake operation
      await this.gcService.clearWorkspaceHibernation(workspaceId);

      return {
        workspaceId,
        status: 'READY',
        desktopEndpoint: result.desktopEndpoint || null,
        vncEndpoint: result.podIP ? `ws://${result.podIP}:6080` : null,
        pvcName: result.pvcName || null,
        podName: result.podName || null,
        podIP: result.podIP || null,
        podPhase: 'Running',
        createdAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error creating workspace ${workspaceId}: ${error.message}`);
      throw new HttpException(
        `Failed to create workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/workspaces/:workspaceId/desktop
   *
   * Get the current status and endpoint of a workspace desktop.
   * Used by agents and workflow orchestrator to check desktop availability.
   */
  @Get(':workspaceId/desktop')
  async getDesktopStatus(
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceDesktopResponse> {
    this.logger.debug(`Get workspace desktop status: ${workspaceId}`);

    try {
      // Check for existing pod
      const pod = await this.k8sService.getWorkspacePod(workspaceId);
      const pvc = await this.k8sService.getWorkspacePVC(workspaceId);

      if (!pod && !pvc) {
        return {
          workspaceId,
          status: 'NOT_FOUND',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: null,
          podName: null,
          podIP: null,
          podPhase: null,
          message: 'Workspace not found. Use POST to create.',
        };
      }

      // PVC exists but no pod - hibernated state
      if (!pod && pvc) {
        return {
          workspaceId,
          status: 'HIBERNATED',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: pvc.metadata?.name || null,
          podName: null,
          podIP: null,
          podPhase: null,
          message: 'Workspace is hibernated. Use POST to wake.',
          createdAt: pvc.metadata?.annotations?.['bytebot.ai/created-at'],
        };
      }

      // Pod exists
      const podPhase = pod?.status?.phase || 'Unknown';
      const podIP = pod?.status?.podIP;
      const allReady = pod?.status?.containerStatuses?.every((cs) => cs.ready) ?? false;

      let status: WorkspaceDesktopResponse['status'];
      if (podPhase === 'Running' && allReady && podIP) {
        status = 'READY';
      } else if (podPhase === 'Pending' || podPhase === 'ContainerCreating') {
        status = 'CREATING';
      } else {
        status = 'ERROR';
      }

      return {
        workspaceId,
        status,
        desktopEndpoint: podIP ? `http://${podIP}:9990` : null,
        vncEndpoint: podIP ? `ws://${podIP}:6080` : null,
        pvcName: pvc?.metadata?.name || null,
        podName: pod?.metadata?.name || null,
        podIP: podIP || null,
        podPhase,
        createdAt: pod?.metadata?.annotations?.['bytebot.ai/created-at'],
      };
    } catch (error: any) {
      this.logger.error(`Error getting workspace status ${workspaceId}: ${error.message}`);
      throw new HttpException(
        `Failed to get workspace status: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/desktop/terminate
   *
   * Terminate a workspace desktop.
   * By default (deletePVC=false), this hibernates the workspace:
   * - Deletes the pod
   * - Keeps the PVC for future resume
   *
   * With deletePVC=true, this fully terminates:
   * - Deletes the pod
   * - Deletes the PVC
   */
  @Post(':workspaceId/desktop/terminate')
  async terminateDesktop(
    @Param('workspaceId') workspaceId: string,
    @Body() body: TerminateWorkspaceRequest = {},
  ): Promise<WorkspaceDesktopResponse> {
    const deletePVC = body.deletePVC ?? false;
    this.logger.log(`Terminate workspace ${workspaceId} (deletePVC=${deletePVC})`);

    try {
      const result = await this.k8sService.terminateWorkspace(workspaceId, deletePVC);

      if (!result.success) {
        throw new HttpException(
          `Failed to terminate workspace: ${result.error}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Check remaining state
      const pvc = await this.k8sService.getWorkspacePVC(workspaceId);

      if (pvc) {
        // Mark workspace as hibernated for GC tracking
        await this.gcService.markWorkspaceHibernated(workspaceId);

        return {
          workspaceId,
          status: 'HIBERNATED',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: pvc.metadata?.name || null,
          podName: null,
          podIP: null,
          podPhase: null,
          message: 'Workspace hibernated. PVC retained for future resume.',
        };
      }

      return {
        workspaceId,
        status: 'TERMINATED',
        desktopEndpoint: null,
        vncEndpoint: null,
        pvcName: null,
        podName: null,
        podIP: null,
        podPhase: null,
        message: 'Workspace fully terminated. PVC deleted.',
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Error terminating workspace ${workspaceId}: ${error.message}`);
      throw new HttpException(
        `Failed to terminate workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/desktop/hibernate
   *
   * Hibernate a workspace desktop (explicit hibernate action).
   * - Deletes the pod
   * - Keeps the PVC for future resume
   *
   * This is equivalent to terminate with deletePVC=false.
   */
  @Post(':workspaceId/desktop/hibernate')
  async hibernateDesktop(
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceDesktopResponse> {
    this.logger.log(`Hibernate workspace ${workspaceId}`);

    try {
      // Delete pod only
      const podResult = await this.k8sService.deleteWorkspacePod(workspaceId);

      if (!podResult.success) {
        throw new HttpException(
          `Failed to hibernate workspace: ${podResult.error}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Check PVC exists
      const pvc = await this.k8sService.getWorkspacePVC(workspaceId);

      if (!pvc) {
        return {
          workspaceId,
          status: 'NOT_FOUND',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: null,
          podName: null,
          podIP: null,
          podPhase: null,
          message: 'Workspace not found (no PVC exists).',
        };
      }

      // Mark workspace as hibernated for GC tracking
      await this.gcService.markWorkspaceHibernated(workspaceId);

      return {
        workspaceId,
        status: 'HIBERNATED',
        desktopEndpoint: null,
        vncEndpoint: null,
        pvcName: pvc.metadata?.name || null,
        podName: null,
        podIP: null,
        podPhase: null,
        message: 'Workspace hibernated. Use POST /desktop to wake.',
        createdAt: pvc.metadata?.annotations?.['bytebot.ai/created-at'],
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Error hibernating workspace ${workspaceId}: ${error.message}`);
      throw new HttpException(
        `Failed to hibernate workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/workspaces/:workspaceId/desktop/wait
   *
   * Wait for a workspace desktop to be ready (long poll).
   * Useful for workflow orchestration to wait for desktop availability
   * without polling.
   *
   * @param timeoutMs - Maximum time to wait (default: 120000ms)
   */
  @Get(':workspaceId/desktop/wait')
  async waitForDesktopReady(
    @Param('workspaceId') workspaceId: string,
    @Query('timeoutMs') timeoutMs?: string,
  ): Promise<WorkspaceDesktopResponse> {
    const timeout = parseInt(timeoutMs || '120000', 10);
    this.logger.debug(`Wait for workspace ${workspaceId} ready (timeout=${timeout}ms)`);

    try {
      const result = await this.k8sService.waitForWorkspacePodReady(
        workspaceId,
        timeout,
        2000, // Poll every 2 seconds
      );

      if (!result.ready) {
        return {
          workspaceId,
          status: 'ERROR',
          desktopEndpoint: null,
          vncEndpoint: null,
          pvcName: null,
          podName: `desktop-${workspaceId}`,
          podIP: null,
          podPhase: null,
          message: `Desktop not ready: ${result.error}`,
        };
      }

      const pvc = await this.k8sService.getWorkspacePVC(workspaceId);

      return {
        workspaceId,
        status: 'READY',
        desktopEndpoint: result.podIP ? `http://${result.podIP}:9990` : null,
        vncEndpoint: result.podIP ? `ws://${result.podIP}:6080` : null,
        pvcName: pvc?.metadata?.name || null,
        podName: `desktop-${workspaceId}`,
        podIP: result.podIP || null,
        podPhase: 'Running',
      };
    } catch (error: any) {
      this.logger.error(`Error waiting for workspace ${workspaceId}: ${error.message}`);
      throw new HttpException(
        `Failed to wait for workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
