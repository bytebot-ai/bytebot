/**
 * Notification Channel Controller
 * Phase 8 (v5.3.0): External Integrations - Unified notification management
 *
 * Endpoints:
 * - GET    /api/v1/notifications/channels          List channels for tenant
 * - POST   /api/v1/notifications/channels          Create notification channel
 * - GET    /api/v1/notifications/channels/:id      Get channel details
 * - PUT    /api/v1/notifications/channels/:id      Update channel
 * - DELETE /api/v1/notifications/channels/:id      Delete channel
 * - POST   /api/v1/notifications/channels/:id/test Test channel delivery
 * - GET    /api/v1/notifications/channels/:id/deliveries Get delivery history
 * - GET    /api/v1/notifications/types             Get available channel types
 * - GET    /api/v1/notifications/events            Get available event types
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiQuery,
} from '@nestjs/swagger';
import { SlackNotificationService, SlackEventType } from '../services/slack-notification.service';
import { TeamsNotificationService, TeamsEventType } from '../services/teams-notification.service';
import { PrismaService } from '../services/prisma.service';

/**
 * Notification channel types
 */
export enum NotificationChannelType {
  SLACK = 'SLACK',
  TEAMS = 'TEAMS',
  EMAIL = 'EMAIL',
  CUSTOM_WEBHOOK = 'CUSTOM_WEBHOOK',
}

/**
 * DTOs for notification endpoints
 */
interface CreateChannelDto {
  type: NotificationChannelType;
  name: string;
  description?: string;
  config: {
    webhookUrl?: string;
    email?: string;
    // Slack-specific
    channel?: string;
    username?: string;
    iconEmoji?: string;
    // Teams-specific
    mentionUsers?: string[];
    // Custom webhook
    headers?: Record<string, string>;
    method?: 'POST' | 'PUT';
  };
  events: string[];
  filters?: {
    goalPatterns?: string[];
    statuses?: string[];
    priorities?: string[];
  };
}

interface UpdateChannelDto {
  name?: string;
  description?: string;
  config?: Record<string, any>;
  events?: string[];
  filters?: Record<string, any>;
  enabled?: boolean;
}

interface ListChannelsQuery {
  type?: NotificationChannelType;
  limit?: string;
  offset?: string;
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slackService: SlackNotificationService,
    private readonly teamsService: TeamsNotificationService,
  ) {}

  /**
   * GET /api/v1/notifications/channels
   * List notification channels for a tenant
   */
  @Get('channels')
  @ApiOperation({ summary: 'List notification channels' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiQuery({ name: 'type', required: false, enum: NotificationChannelType })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Channels retrieved successfully' })
  async listChannels(
    @Query() query: ListChannelsQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const limit = parseInt(query.limit || '20', 10);
    const offset = parseInt(query.offset || '0', 10);

    const where = {
      tenantId,
      ...(query.type && { type: query.type }),
    };

    const [channels, total] = await Promise.all([
      this.prisma.notificationChannel.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.notificationChannel.count({ where }),
    ]);

    return {
      success: true,
      channels: channels.map((c) => this.formatChannel(c)),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + channels.length < total,
      },
    };
  }

  /**
   * POST /api/v1/notifications/channels
   * Create a new notification channel
   */
  @Post('channels')
  @ApiOperation({ summary: 'Create notification channel' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 201, description: 'Channel created successfully' })
  async createChannel(
    @Body() body: CreateChannelDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Validate required fields
    if (!body.type) {
      throw new HttpException('type is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.name) {
      throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.events || body.events.length === 0) {
      throw new HttpException('events array is required', HttpStatus.BAD_REQUEST);
    }

    // Validate channel type
    if (!Object.values(NotificationChannelType).includes(body.type)) {
      throw new HttpException(
        `Invalid channel type. Valid types: ${Object.values(NotificationChannelType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // Validate config based on type
    this.validateChannelConfig(body.type, body.config);

    // Validate event types
    const validEvents = this.getValidEventTypes();
    const invalidEvents = body.events.filter((e) => !validEvents.includes(e));
    if (invalidEvents.length > 0) {
      throw new HttpException(
        `Invalid event types: ${invalidEvents.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const channel = await this.prisma.notificationChannel.create({
        data: {
          tenantId,
          type: body.type,
          name: body.name,
          description: body.description,
          config: body.config as any,
          events: body.events,
          filters: (body.filters || {}) as any,
          enabled: true,
          verified: false,
        },
      });

      this.logger.log(
        `Created ${body.type} notification channel ${channel.id} for tenant ${tenantId}`,
      );

      return {
        success: true,
        channel: this.formatChannel(channel),
        message: 'Channel created successfully. Test the channel to verify configuration.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to create notification channel: ${error.message}`);
      throw new HttpException(
        `Failed to create channel: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/notifications/channels/:id
   * Get channel details
   */
  @Get('channels/:id')
  @ApiOperation({ summary: 'Get notification channel details' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Channel retrieved successfully' })
  async getChannel(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id, tenantId },
    });

    if (!channel) {
      throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      channel: this.formatChannel(channel),
    };
  }

  /**
   * PUT /api/v1/notifications/channels/:id
   * Update notification channel
   */
  @Put('channels/:id')
  @ApiOperation({ summary: 'Update notification channel' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Channel updated successfully' })
  async updateChannel(
    @Param('id') id: string,
    @Body() body: UpdateChannelDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Check channel exists and belongs to tenant
    const existing = await this.prisma.notificationChannel.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    }

    // Validate config if provided
    if (body.config) {
      this.validateChannelConfig(
        existing.type as NotificationChannelType,
        { ...existing.config as any, ...body.config },
      );
    }

    // Validate events if provided
    if (body.events) {
      const validEvents = this.getValidEventTypes();
      const invalidEvents = body.events.filter((e) => !validEvents.includes(e));
      if (invalidEvents.length > 0) {
        throw new HttpException(
          `Invalid event types: ${invalidEvents.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      const channel = await this.prisma.notificationChannel.update({
        where: { id },
        data: {
          ...(body.name && { name: body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.config && { config: body.config as any }),
          ...(body.events && { events: body.events }),
          ...(body.filters && { filters: body.filters as any }),
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          // Reset verified status if config changed
          ...(body.config && { verified: false }),
        },
      });

      this.logger.log(`Updated notification channel ${id}`);

      return {
        success: true,
        channel: this.formatChannel(channel),
        message: 'Channel updated successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to update channel ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to update channel: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * DELETE /api/v1/notifications/channels/:id
   * Delete notification channel
   */
  @Delete('channels/:id')
  @ApiOperation({ summary: 'Delete notification channel' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Channel deleted successfully' })
  async deleteChannel(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Check channel exists and belongs to tenant
    const existing = await this.prisma.notificationChannel.findFirst({
      where: { id, tenantId },
    });

    if (!existing) {
      throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    }

    try {
      await this.prisma.notificationChannel.delete({ where: { id } });

      this.logger.log(`Deleted notification channel ${id}`);

      return {
        success: true,
        message: 'Channel deleted successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete channel ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to delete channel: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/notifications/channels/:id/test
   * Test notification channel
   */
  @Post('channels/:id/test')
  @ApiOperation({ summary: 'Test notification channel delivery' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Test notification sent' })
  async testChannel(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id, tenantId },
    });

    if (!channel) {
      throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    }

    try {
      let result: { success: boolean; error?: string };

      switch (channel.type) {
        case NotificationChannelType.SLACK:
          result = await this.slackService.testChannel(id);
          break;
        case NotificationChannelType.TEAMS:
          result = await this.teamsService.testChannel(id);
          break;
        default:
          result = { success: false, error: 'Test not implemented for this channel type' };
      }

      if (result.success) {
        // Mark channel as verified
        await this.prisma.notificationChannel.update({
          where: { id },
          data: { verified: true },
        });

        return {
          success: true,
          message: 'Test notification sent successfully',
        };
      } else {
        return {
          success: false,
          message: 'Test notification failed',
          error: result.error,
        };
      }
    } catch (error: any) {
      this.logger.error(`Failed to test channel ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to test channel: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/notifications/channels/:id/deliveries
   * Get channel delivery history
   */
  @Get('channels/:id/deliveries')
  @ApiOperation({ summary: 'Get notification delivery history' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'Deliveries retrieved successfully' })
  async getDeliveries(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify channel belongs to tenant
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id, tenantId },
    });

    if (!channel) {
      throw new HttpException('Channel not found', HttpStatus.NOT_FOUND);
    }

    const deliveryLimit = parseInt(limit || '50', 10);

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { channelId: id },
      orderBy: { createdAt: 'desc' },
      take: deliveryLimit,
    });

    return {
      success: true,
      deliveries: deliveries.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.eventType,
        success: d.success,
        statusCode: d.statusCode,
        error: d.error,
        attempts: d.attempts,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * GET /api/v1/notifications/types
   * Get available channel types
   */
  @Get('types')
  @ApiOperation({ summary: 'Get available notification channel types' })
  @ApiResponse({ status: 200, description: 'Channel types retrieved' })
  getChannelTypes() {
    return {
      success: true,
      types: [
        {
          type: NotificationChannelType.SLACK,
          name: 'Slack',
          description: 'Send notifications to a Slack channel via Incoming Webhook',
          configFields: [
            { name: 'webhookUrl', type: 'string', required: true, description: 'Slack Incoming Webhook URL' },
            { name: 'channel', type: 'string', required: false, description: 'Override channel (optional)' },
            { name: 'username', type: 'string', required: false, description: 'Bot username (optional)' },
            { name: 'iconEmoji', type: 'string', required: false, description: 'Bot icon emoji (optional)' },
          ],
        },
        {
          type: NotificationChannelType.TEAMS,
          name: 'Microsoft Teams',
          description: 'Send notifications to a Teams channel via Incoming Webhook',
          configFields: [
            { name: 'webhookUrl', type: 'string', required: true, description: 'Teams Incoming Webhook URL' },
            { name: 'mentionUsers', type: 'array', required: false, description: 'User emails to @mention' },
          ],
        },
        {
          type: NotificationChannelType.EMAIL,
          name: 'Email',
          description: 'Send notifications via email (coming soon)',
          configFields: [
            { name: 'email', type: 'string', required: true, description: 'Recipient email address' },
          ],
        },
        {
          type: NotificationChannelType.CUSTOM_WEBHOOK,
          name: 'Custom Webhook',
          description: 'Send notifications to a custom HTTP endpoint',
          configFields: [
            { name: 'webhookUrl', type: 'string', required: true, description: 'Webhook URL' },
            { name: 'method', type: 'string', required: false, description: 'HTTP method (POST or PUT)' },
            { name: 'headers', type: 'object', required: false, description: 'Custom HTTP headers' },
          ],
        },
      ],
    };
  }

  /**
   * GET /api/v1/notifications/events
   * Get available event types
   */
  @Get('events')
  @ApiOperation({ summary: 'Get available notification event types' })
  @ApiResponse({ status: 200, description: 'Event types retrieved' })
  getEventTypes() {
    return {
      success: true,
      events: [
        // Goal events
        { type: 'GOAL_STARTED', category: 'goals', description: 'Goal run has started' },
        { type: 'GOAL_COMPLETED', category: 'goals', description: 'Goal run completed successfully' },
        { type: 'GOAL_FAILED', category: 'goals', description: 'Goal run failed' },
        { type: 'GOAL_CANCELLED', category: 'goals', description: 'Goal run was cancelled' },
        { type: 'GOAL_PLANNING', category: 'goals', description: 'Goal is being planned' },
        { type: 'GOAL_EXECUTING', category: 'goals', description: 'Goal is executing' },
        // Batch events
        { type: 'BATCH_STARTED', category: 'batches', description: 'Batch execution started' },
        { type: 'BATCH_COMPLETED', category: 'batches', description: 'Batch execution completed' },
        { type: 'BATCH_FAILED', category: 'batches', description: 'Batch execution failed' },
        { type: 'BATCH_CANCELLED', category: 'batches', description: 'Batch execution cancelled' },
        { type: 'BATCH_PROGRESS', category: 'batches', description: 'Batch progress update' },
        // Approval events
        { type: 'APPROVAL_REQUESTED', category: 'approvals', description: 'Approval is requested' },
        { type: 'APPROVAL_APPROVED', category: 'approvals', description: 'Action was approved' },
        { type: 'APPROVAL_REJECTED', category: 'approvals', description: 'Action was rejected' },
        { type: 'APPROVAL_EXPIRED', category: 'approvals', description: 'Approval request expired' },
      ],
    };
  }

  /**
   * Validate channel config based on type
   */
  private validateChannelConfig(type: NotificationChannelType, config: any) {
    switch (type) {
      case NotificationChannelType.SLACK:
      case NotificationChannelType.TEAMS:
        if (!config.webhookUrl) {
          throw new HttpException('webhookUrl is required', HttpStatus.BAD_REQUEST);
        }
        try {
          new URL(config.webhookUrl);
        } catch {
          throw new HttpException('Invalid webhookUrl format', HttpStatus.BAD_REQUEST);
        }
        break;

      case NotificationChannelType.EMAIL:
        if (!config.email) {
          throw new HttpException('email is required', HttpStatus.BAD_REQUEST);
        }
        // Basic email validation
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) {
          throw new HttpException('Invalid email format', HttpStatus.BAD_REQUEST);
        }
        break;

      case NotificationChannelType.CUSTOM_WEBHOOK:
        if (!config.webhookUrl) {
          throw new HttpException('webhookUrl is required', HttpStatus.BAD_REQUEST);
        }
        try {
          new URL(config.webhookUrl);
        } catch {
          throw new HttpException('Invalid webhookUrl format', HttpStatus.BAD_REQUEST);
        }
        break;
    }
  }

  /**
   * Get valid event types
   */
  private getValidEventTypes(): string[] {
    return [
      // Goal events
      SlackEventType.GOAL_STARTED,
      SlackEventType.GOAL_COMPLETED,
      SlackEventType.GOAL_FAILED,
      SlackEventType.GOAL_CANCELLED,
      // Batch events
      SlackEventType.BATCH_STARTED,
      SlackEventType.BATCH_COMPLETED,
      SlackEventType.BATCH_FAILED,
      SlackEventType.BATCH_PROGRESS,
      // Approval events
      SlackEventType.APPROVAL_REQUESTED,
      SlackEventType.APPROVAL_APPROVED,
      SlackEventType.APPROVAL_REJECTED,
      SlackEventType.APPROVAL_EXPIRED,
      // User prompt events (durable WAIT surface)
      SlackEventType.USER_PROMPT_CREATED,
      SlackEventType.USER_PROMPT_RESOLVED,
    ];
  }

  /**
   * Format channel for response (hide sensitive config)
   */
  private formatChannel(channel: any) {
    const config = { ...(channel.config as any) };

    // Mask webhook URL
    if (config.webhookUrl) {
      const url = new URL(config.webhookUrl);
      config.webhookUrl = `${url.protocol}//${url.host}/...${url.pathname.slice(-8)}`;
    }

    return {
      id: channel.id,
      tenantId: channel.tenantId,
      type: channel.type,
      name: channel.name,
      description: channel.description,
      config,
      events: channel.events,
      filters: channel.filters,
      enabled: channel.enabled,
      verified: channel.verified,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }
}
