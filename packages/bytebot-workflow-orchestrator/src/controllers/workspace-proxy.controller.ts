/**
 * Workspace Proxy Controller
 * v1.0.0: Proxy for workspace operations
 *
 * This controller provides a convenient API for accessing workspace
 * information without direct access to task-controller.
 * It's primarily used by UI components and monitoring.
 */

import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { WorkspaceService } from '../services/workspace.service';
import { PrismaService } from '../services/prisma.service';

/**
 * v2.3.0 M4: Lock request DTOs
 */
interface AcquireLockDto {
  nodeRunId: string;
  leaseSeconds?: number;
}

interface RenewLockDto {
  nodeRunId: string;
  leaseSeconds?: number;
}

interface ReleaseLockDto {
  nodeRunId: string;
}

@Controller('workspaces')
export class WorkspaceProxyController {
  private readonly logger = new Logger(WorkspaceProxyController.name);

  constructor(
    private workspaceService: WorkspaceService,
    private prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/workspaces/:workspaceId
   * Get workspace details including DB record and desktop status
   */
  @Get(':workspaceId')
  async getWorkspace(@Param('workspaceId') workspaceId: string) {
    // Get DB record
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        workflowRun: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });

    if (!workspace) {
      throw new HttpException('Workspace not found', HttpStatus.NOT_FOUND);
    }

    // Get desktop status from task-controller
    const desktopStatus = await this.workspaceService.getWorkspaceDesktopStatus(
      workspaceId,
    );

    return {
      success: true,
      workspace: {
        ...workspace,
        desktop: desktopStatus,
      },
    };
  }

  /**
   * GET /api/v1/workspaces/:workspaceId/desktop
   * Get just the desktop status
   */
  @Get(':workspaceId/desktop')
  async getDesktopStatus(@Param('workspaceId') workspaceId: string) {
    const status = await this.workspaceService.getWorkspaceDesktopStatus(
      workspaceId,
    );

    return {
      success: true,
      desktop: status,
    };
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/wake
   * Wake a hibernated workspace
   */
  @Post(':workspaceId/wake')
  async wakeWorkspace(@Param('workspaceId') workspaceId: string) {
    this.logger.log(`Waking workspace ${workspaceId}`);

    // Get workspace from DB
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) {
      throw new HttpException('Workspace not found', HttpStatus.NOT_FOUND);
    }

    try {
      const status = await this.workspaceService.ensureWorkspaceDesktop(
        workspaceId,
        workspace.tenantId,
        {
          enabled: workspace.persistenceEnabled,
          storageClass: workspace.storageClass || undefined,
          size: workspace.storageSize || undefined,
        },
      );

      // Update DB record
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: status.status === 'READY' ? 'READY' : 'CREATING' },
      });

      return {
        success: true,
        desktop: status,
      };
    } catch (error: any) {
      this.logger.error(`Failed to wake workspace: ${error.message}`);
      throw new HttpException(
        `Failed to wake workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/hibernate
   * Hibernate workspace (delete pod, keep PVC)
   */
  @Post(':workspaceId/hibernate')
  async hibernateWorkspace(@Param('workspaceId') workspaceId: string) {
    this.logger.log(`Hibernating workspace ${workspaceId}`);

    try {
      const status = await this.workspaceService.hibernateWorkspace(workspaceId);

      // Update DB record
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'HIBERNATED' },
      });

      return {
        success: true,
        desktop: status,
      };
    } catch (error: any) {
      this.logger.error(`Failed to hibernate workspace: ${error.message}`);
      throw new HttpException(
        `Failed to hibernate workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/terminate
   * Fully terminate workspace (delete pod and PVC)
   */
  @Post(':workspaceId/terminate')
  async terminateWorkspace(@Param('workspaceId') workspaceId: string) {
    this.logger.log(`Terminating workspace ${workspaceId}`);

    try {
      const status = await this.workspaceService.terminateWorkspace(
        workspaceId,
        true,
      );

      // Update DB record
      await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'TERMINATED' },
      });

      return {
        success: true,
        desktop: status,
      };
    } catch (error: any) {
      this.logger.error(`Failed to terminate workspace: ${error.message}`);
      throw new HttpException(
        `Failed to terminate workspace: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ============================================================================
  // v2.3.0 M4: Workspace Lock Endpoints
  // Granular locking for desktop tool execution (30-60 second leases)
  // ============================================================================

  /**
   * POST /api/v1/workspaces/:workspaceId/lock
   * Acquire a granular lock on the workspace for desktop tool execution
   */
  @Post(':workspaceId/lock')
  async acquireLock(
    @Param('workspaceId') workspaceId: string,
    @Body() body: AcquireLockDto,
  ) {
    if (!body.nodeRunId) {
      throw new HttpException('nodeRunId is required', HttpStatus.BAD_REQUEST);
    }

    this.logger.log(
      `Lock request on workspace ${workspaceId} by nodeRun ${body.nodeRunId}`,
    );

    const result = await this.workspaceService.acquireLock(
      workspaceId,
      body.nodeRunId,
      body.leaseSeconds || 30,
    );

    if (!result.acquired) {
      throw new HttpException(
        {
          success: false,
          message: result.message,
          retryAfterMs: result.retryAfterMs,
          currentOwner: result.currentOwner,
        },
        HttpStatus.CONFLICT,
      );
    }

    return {
      success: true,
      acquired: true,
      lockExpiresAt: result.lockExpiresAt,
      message: result.message,
    };
  }

  /**
   * POST /api/v1/workspaces/:workspaceId/lock/renew
   * Renew an existing lock
   */
  @Post(':workspaceId/lock/renew')
  async renewLock(
    @Param('workspaceId') workspaceId: string,
    @Body() body: RenewLockDto,
  ) {
    if (!body.nodeRunId) {
      throw new HttpException('nodeRunId is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.workspaceService.renewLock(
      workspaceId,
      body.nodeRunId,
      body.leaseSeconds || 30,
    );

    if (!result.renewed) {
      throw new HttpException(
        {
          success: false,
          message: result.message,
        },
        HttpStatus.CONFLICT,
      );
    }

    return {
      success: true,
      renewed: true,
      lockExpiresAt: result.lockExpiresAt,
      message: result.message,
    };
  }

  /**
   * DELETE /api/v1/workspaces/:workspaceId/lock
   * Release a lock on the workspace
   */
  @Delete(':workspaceId/lock')
  async releaseLock(
    @Param('workspaceId') workspaceId: string,
    @Body() body: ReleaseLockDto,
  ) {
    if (!body.nodeRunId) {
      throw new HttpException('nodeRunId is required', HttpStatus.BAD_REQUEST);
    }

    const result = await this.workspaceService.releaseLock(
      workspaceId,
      body.nodeRunId,
    );

    return {
      success: true,
      released: result.released,
      message: result.message,
    };
  }

  /**
   * GET /api/v1/workspaces/:workspaceId/lock
   * Get current lock status for a workspace
   */
  @Get(':workspaceId/lock')
  async getLockStatus(@Param('workspaceId') workspaceId: string) {
    const status = await this.workspaceService.getLockStatus(workspaceId);

    return {
      success: true,
      ...status,
    };
  }
}
