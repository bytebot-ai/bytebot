import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SlackBridgeService } from '../services/slack-bridge.service';

@Controller()
export class SlackBridgeController {
  constructor(private readonly slackBridgeService: SlackBridgeService) {}

  /**
   * POST /api/v1/slack/interactivity
   * Slack interactive components endpoint (buttons/modals).
   *
   * Notes:
   * - Requires Slack request signature verification.
   * - Does not expose any secrets; uses SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN env vars.
   */
  @Post('slack/interactivity')
  @HttpCode(HttpStatus.OK)
  async interactivity(
    @Body() body: any,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-slack-signature') slackSignature?: string,
    @Headers('x-slack-request-timestamp') slackTimestamp?: string,
  ) {
    if (!this.slackBridgeService.isEnabled()) {
      throw new BadRequestException('Slack reply-in-Slack is not enabled');
    }

    const ok = this.slackBridgeService.verifySlackRequest({
      rawBody: req.rawBody,
      signature: slackSignature,
      timestamp: slackTimestamp,
    });
    if (!ok) {
      throw new UnauthorizedException('Invalid Slack signature');
    }

    const payloadRaw = typeof body?.payload === 'string' ? body.payload : null;
    if (!payloadRaw) {
      throw new BadRequestException('Missing payload');
    }

    let payload: any;
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      throw new BadRequestException('Invalid payload JSON');
    }

    return await this.slackBridgeService.handleInteractivity(payload, req.headers as any);
  }
}

