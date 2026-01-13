/**
 * Desktop Control Service
 * Phase 4: Live Desktop Control APIs
 *
 * Responsibilities:
 * - Get desktop status for goal runs
 * - Wake hibernated desktops
 * - Capture screenshots
 * - Coordinate with desktop-router service
 */

import { Injectable, Logger, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { createId } from '@paralleldrive/cuid2';

export interface DesktopStatus {
  runId: string;
  workspaceId?: string;
  status: 'ready' | 'starting' | 'hibernated' | 'unavailable' | 'error';
  vncReady: boolean;
  podIP?: string;
  hibernated: boolean;
  lastActiveAt?: Date;
  error?: string;
}

export interface DesktopUrls {
  direct?: string;
  websockify?: string;
  workspaceVnc?: string;
  expiresAt: Date;
}

export interface Screenshot {
  id: string;
  runId: string;
  url: string;
  thumbnailUrl?: string;
  timestamp: Date;
  stepId?: string;
  stepDescription?: string;
}

@Injectable()
export class DesktopControlService {
  private readonly logger = new Logger(DesktopControlService.name);

  // Desktop router service URL (from env)
  private readonly desktopRouterUrl = process.env.DESKTOP_ROUTER_URL || 'http://desktop-router:3000';

  // Screenshot storage URL (from env)
  private readonly screenshotStorageUrl = process.env.SCREENSHOT_STORAGE_URL || '/api/screenshots';

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Get desktop status for a goal run
   */
  async getDesktopStatus(runId: string): Promise<DesktopStatus> {
    this.logger.log(`Getting desktop status for run ${runId}`);

    // Get goal run to find workspace
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: runId },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${runId} not found`);
    }

    try {
      // Query desktop-router for status
      const response = await fetch(`${this.desktopRouterUrl}/desktop/runs/${runId}/status`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            runId,
            status: 'unavailable',
            vncReady: false,
            hibernated: false,
          };
        }
        throw new Error(`Desktop router returned ${response.status}`);
      }

      const data = await response.json();

      return {
        runId,
        workspaceId: data.workspaceId,
        status: data.status || 'ready',
        vncReady: data.vncReady ?? true,
        podIP: data.podIP,
        hibernated: data.hibernated ?? false,
        lastActiveAt: data.lastActiveAt ? new Date(data.lastActiveAt) : undefined,
      };
    } catch (error: any) {
      this.logger.warn(`Failed to get desktop status: ${error.message}`);

      // Return degraded status
      return {
        runId,
        status: 'error',
        vncReady: false,
        hibernated: false,
        error: error.message,
      };
    }
  }

  /**
   * Get VNC connection URLs for a goal run
   */
  async getDesktopUrls(runId: string): Promise<DesktopUrls> {
    this.logger.log(`Getting desktop URLs for run ${runId}`);

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: runId },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${runId} not found`);
    }

    try {
      const response = await fetch(`${this.desktopRouterUrl}/desktop/runs/${runId}/url`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new HttpException(
          `Failed to get desktop URLs: ${response.statusText}`,
          response.status,
        );
      }

      const data = await response.json();

      return {
        direct: data.urls?.direct,
        websockify: data.urls?.websockify,
        workspaceVnc: data.urls?.workspaceVnc,
        expiresAt: new Date(data.expiresAt || Date.now() + 3600000), // 1 hour default
      };
    } catch (error: any) {
      this.logger.error(`Failed to get desktop URLs: ${error.message}`);
      throw new HttpException(
        `Failed to get desktop URLs: ${error.message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Wake a hibernated desktop
   */
  async wakeDesktop(runId: string): Promise<{ status: string; estimatedReady: string }> {
    this.logger.log(`Waking desktop for run ${runId}`);

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: runId },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${runId} not found`);
    }

    try {
      const response = await fetch(`${this.desktopRouterUrl}/desktop/runs/${runId}/wake`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new HttpException(
          `Failed to wake desktop: ${response.statusText}`,
          response.status,
        );
      }

      const data = await response.json();

      // Emit event for tracking
      this.eventEmitter.emit('desktop.waking', { runId });

      return {
        status: data.status || 'waking',
        estimatedReady: data.estimatedReady || '30s',
      };
    } catch (error: any) {
      this.logger.error(`Failed to wake desktop: ${error.message}`);
      throw new HttpException(
        `Failed to wake desktop: ${error.message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Capture a screenshot from the desktop
   */
  async captureScreenshot(
    runId: string,
    stepId?: string,
  ): Promise<Screenshot> {
    this.logger.log(`Capturing screenshot for run ${runId}`);

    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: runId },
      include: {
        planVersions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: {
            checklistItems: true,
          },
        },
      },
    });

    if (!goalRun) {
      throw new NotFoundException(`Goal run ${runId} not found`);
    }

    // Get step description if stepId provided
    let stepDescription: string | undefined;
    if (stepId) {
      const step = goalRun.planVersions[0]?.checklistItems.find(
        (item) => item.id === stepId,
      );
      stepDescription = step?.description;
    }

    const screenshotId = `ss-${createId()}`;
    const timestamp = new Date();

    try {
      // Request screenshot from desktop-router
      const response = await fetch(`${this.desktopRouterUrl}/desktop/runs/${runId}/screenshot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ screenshotId }),
      });

      if (!response.ok) {
        throw new HttpException(
          `Failed to capture screenshot: ${response.statusText}`,
          response.status,
        );
      }

      const data = await response.json();

      const screenshot: Screenshot = {
        id: screenshotId,
        runId,
        url: data.url || `${this.screenshotStorageUrl}/${screenshotId}`,
        thumbnailUrl: data.thumbnailUrl,
        timestamp,
        stepId,
        stepDescription,
      };

      // Store screenshot reference in activity event
      await this.prisma.activityEvent.create({
        data: {
          goalRunId: runId,
          eventType: 'SCREENSHOT_CAPTURED',
          title: 'Screenshot captured',
          description: stepDescription ? `During: ${stepDescription}` : undefined,
          details: {
            screenshotId,
            url: screenshot.url,
            stepId,
          } as object,
          checklistItemId: stepId,
        },
      });

      // Emit event for real-time delivery
      this.eventEmitter.emit('screenshot.captured', {
        runId,
        screenshot,
      });

      return screenshot;
    } catch (error: any) {
      this.logger.error(`Failed to capture screenshot: ${error.message}`);
      throw new HttpException(
        `Failed to capture screenshot: ${error.message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /**
   * Get screenshots for a goal run
   */
  async getScreenshots(runId: string): Promise<Screenshot[]> {
    this.logger.log(`Getting screenshots for run ${runId}`);

    const events = await this.prisma.activityEvent.findMany({
      where: {
        goalRunId: runId,
        eventType: 'SCREENSHOT_CAPTURED',
      },
      orderBy: { createdAt: 'asc' },
    });

    return events.map((event) => {
      const details = event.details as { screenshotId?: string; url?: string; stepId?: string } | null;
      return {
        id: details?.screenshotId || event.id,
        runId,
        url: details?.url || '',
        timestamp: event.createdAt,
        stepId: details?.stepId,
        stepDescription: event.description?.replace('During: ', ''),
      };
    });
  }
}
