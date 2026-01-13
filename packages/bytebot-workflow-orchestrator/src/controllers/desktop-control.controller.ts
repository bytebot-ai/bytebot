/**
 * Desktop Control Controller
 * Phase 4: Live Desktop Control APIs
 *
 * REST endpoints for desktop control operations:
 * - GET /api/v1/desktop/runs/:runId/status - Get desktop status
 * - GET /api/v1/desktop/runs/:runId/url - Get VNC URLs
 * - POST /api/v1/desktop/runs/:runId/wake - Wake hibernated desktop
 * - POST /api/v1/desktop/runs/:runId/screenshot - Capture screenshot
 * - GET /api/v1/desktop/runs/:runId/screenshots - Get all screenshots
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  Body,
} from '@nestjs/common';
import { DesktopControlService } from '../services/desktop-control.service';

// v5.11.3: Removed deprecated api/v1/desktop backward compatibility prefix (was scheduled for v5.6.0)
@Controller('desktop')
export class DesktopControlController {
  constructor(private desktopControlService: DesktopControlService) {}

  /**
   * GET /api/v1/desktop/runs/:runId/status
   * Get desktop status for a goal run
   */
  @Get('runs/:runId/status')
  async getDesktopStatus(@Param('runId') runId: string) {
    const status = await this.desktopControlService.getDesktopStatus(runId);

    return {
      success: true,
      data: status,
    };
  }

  /**
   * GET /api/v1/desktop/runs/:runId/url
   * Get VNC connection URLs
   */
  @Get('runs/:runId/url')
  async getDesktopUrls(@Param('runId') runId: string) {
    const urls = await this.desktopControlService.getDesktopUrls(runId);

    return {
      success: true,
      data: urls,
    };
  }

  /**
   * POST /api/v1/desktop/runs/:runId/wake
   * Wake a hibernated desktop
   */
  @Post('runs/:runId/wake')
  @HttpCode(HttpStatus.OK)
  async wakeDesktop(@Param('runId') runId: string) {
    const result = await this.desktopControlService.wakeDesktop(runId);

    return {
      success: true,
      data: result,
    };
  }

  /**
   * POST /api/v1/desktop/runs/:runId/screenshot
   * Capture a screenshot
   */
  @Post('runs/:runId/screenshot')
  @HttpCode(HttpStatus.CREATED)
  async captureScreenshot(
    @Param('runId') runId: string,
    @Body() body?: { stepId?: string },
  ) {
    const screenshot = await this.desktopControlService.captureScreenshot(
      runId,
      body?.stepId,
    );

    return {
      success: true,
      data: screenshot,
    };
  }

  /**
   * GET /api/v1/desktop/runs/:runId/screenshots
   * Get all screenshots for a goal run
   */
  @Get('runs/:runId/screenshots')
  async getScreenshots(@Param('runId') runId: string) {
    const screenshots = await this.desktopControlService.getScreenshots(runId);

    return {
      success: true,
      data: screenshots,
    };
  }
}
