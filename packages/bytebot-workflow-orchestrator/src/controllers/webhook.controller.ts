/**
 * Webhook Controller
 * Post-M5 Enhancement: API endpoints for managing webhook configurations
 *
 * Endpoints:
 * - GET  /api/v1/webhooks           List webhooks for tenant
 * - POST /api/v1/webhooks           Create webhook configuration
 * - GET  /api/v1/webhooks/:id       Get webhook details
 * - PUT  /api/v1/webhooks/:id       Update webhook configuration
 * - DELETE /api/v1/webhooks/:id     Delete webhook
 * - POST /api/v1/webhooks/:id/test  Test webhook delivery
 * - POST /api/v1/webhooks/:id/rotate-secret  Rotate webhook secret
 * - GET  /api/v1/webhooks/:id/deliveries     Get delivery history
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
import { WebhookService, WebhookEventType } from '../services/webhook.service';

/**
 * DTOs for webhook endpoints
 */
interface CreateWebhookDto {
  url: string;
  events: string[];
  secret?: string;
}

interface UpdateWebhookDto {
  url?: string;
  events?: string[];
  enabled?: boolean;
}

interface ListWebhooksQuery {
  limit?: string;
  offset?: string;
}

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhookService: WebhookService) {}

  /**
   * GET /api/v1/webhooks
   * List webhooks for a tenant
   */
  @Get()
  async listWebhooks(
    @Query() query: ListWebhooksQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const limit = parseInt(query.limit || '20', 10);
    const offset = parseInt(query.offset || '0', 10);

    // Get all webhooks for tenant (we'll implement pagination in the service if needed)
    const allEvents = Object.values(WebhookEventType);
    const webhooks: any[] = [];

    for (const eventType of allEvents) {
      const eventWebhooks = await this.webhookService.getActiveWebhooks(tenantId, eventType);
      for (const webhook of eventWebhooks) {
        if (!webhooks.find((w) => w.id === webhook.id)) {
          webhooks.push(webhook);
        }
      }
    }

    // Apply pagination
    const paginated = webhooks.slice(offset, offset + limit);

    return {
      success: true,
      webhooks: paginated.map((w) => this.formatWebhook(w)),
      pagination: {
        total: webhooks.length,
        limit,
        offset,
        hasMore: offset + paginated.length < webhooks.length,
      },
    };
  }

  /**
   * POST /api/v1/webhooks
   * Create a new webhook configuration
   */
  @Post()
  async createWebhook(
    @Body() body: CreateWebhookDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    if (!body.url) {
      throw new HttpException('url is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.events || body.events.length === 0) {
      throw new HttpException('events array is required', HttpStatus.BAD_REQUEST);
    }

    // Validate URL
    try {
      new URL(body.url);
    } catch {
      throw new HttpException('Invalid URL format', HttpStatus.BAD_REQUEST);
    }

    // Validate event types
    const validEvents = Object.values(WebhookEventType);
    const invalidEvents = body.events.filter((e) => !validEvents.includes(e as WebhookEventType));
    if (invalidEvents.length > 0) {
      throw new HttpException(
        `Invalid event types: ${invalidEvents.join(', ')}. Valid types: ${validEvents.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const webhook = await this.webhookService.createWebhook({
        tenantId,
        url: body.url,
        events: body.events as WebhookEventType[],
        secret: body.secret,
      });

      this.logger.log(`Created webhook ${webhook.id} for tenant ${tenantId}`);

      return {
        success: true,
        webhook: this.formatWebhookWithSecret(webhook),
        message: 'Webhook created successfully. Save the secret - it will not be shown again.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to create webhook: ${error.message}`);
      throw new HttpException(
        `Failed to create webhook: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/webhooks/:id
   * Get webhook details
   */
  @Get(':id')
  async getWebhook(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // For now, just return basic info - we'd need a getById method in the service
    throw new HttpException(
      'Get by ID not yet implemented - use list endpoint',
      HttpStatus.NOT_IMPLEMENTED,
    );
  }

  /**
   * PUT /api/v1/webhooks/:id
   * Update webhook configuration
   */
  @Put(':id')
  async updateWebhook(
    @Param('id') id: string,
    @Body() body: UpdateWebhookDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Validate URL if provided
    if (body.url) {
      try {
        new URL(body.url);
      } catch {
        throw new HttpException('Invalid URL format', HttpStatus.BAD_REQUEST);
      }
    }

    // Validate event types if provided
    if (body.events) {
      const validEvents = Object.values(WebhookEventType);
      const invalidEvents = body.events.filter((e) => !validEvents.includes(e as WebhookEventType));
      if (invalidEvents.length > 0) {
        throw new HttpException(
          `Invalid event types: ${invalidEvents.join(', ')}`,
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    try {
      const webhook = await this.webhookService.updateWebhook(id, {
        url: body.url,
        events: body.events as WebhookEventType[] | undefined,
        enabled: body.enabled,
      });

      this.logger.log(`Updated webhook ${id}`);

      return {
        success: true,
        webhook: this.formatWebhook(webhook),
        message: 'Webhook updated successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to update webhook ${id}: ${error.message}`);

      if (error.code === 'P2025') {
        throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to update webhook: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * DELETE /api/v1/webhooks/:id
   * Delete webhook configuration
   */
  @Delete(':id')
  async deleteWebhook(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    try {
      await this.webhookService.deleteWebhook(id);

      this.logger.log(`Deleted webhook ${id}`);

      return {
        success: true,
        message: 'Webhook deleted successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete webhook ${id}: ${error.message}`);

      if (error.code === 'P2025') {
        throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to delete webhook: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/webhooks/:id/test
   * Test webhook delivery
   */
  @Post(':id/test')
  async testWebhook(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.webhookService.testWebhook(id);

      if (result.success) {
        return {
          success: true,
          message: 'Test webhook delivered successfully',
          statusCode: result.statusCode,
          attempts: result.attempts,
        };
      } else {
        return {
          success: false,
          message: 'Test webhook delivery failed',
          error: result.error,
          statusCode: result.statusCode,
          attempts: result.attempts,
        };
      }
    } catch (error: any) {
      this.logger.error(`Failed to test webhook ${id}: ${error.message}`);

      if (error.message === 'Webhook not found') {
        throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to test webhook: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/webhooks/:id/rotate-secret
   * Rotate webhook secret
   */
  @Post(':id/rotate-secret')
  async rotateSecret(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    try {
      const result = await this.webhookService.rotateSecret(id);

      this.logger.log(`Rotated secret for webhook ${id}`);

      return {
        success: true,
        secret: result.secret,
        message: 'Secret rotated successfully. Save the new secret - it will not be shown again.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to rotate secret for webhook ${id}: ${error.message}`);

      if (error.code === 'P2025') {
        throw new HttpException('Webhook not found', HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to rotate secret: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/webhooks/:id/deliveries
   * Get webhook delivery history
   */
  @Get(':id/deliveries')
  async getDeliveries(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const deliveryLimit = parseInt(limit || '50', 10);

    try {
      const deliveries = await this.webhookService.getDeliveryHistory(id, deliveryLimit);

      return {
        success: true,
        deliveries: deliveries.map((d: any) => ({
          id: d.id,
          eventId: d.eventId,
          success: d.success,
          statusCode: d.statusCode,
          error: d.error,
          attempts: d.attempts,
          deliveredAt: d.deliveredAt,
          createdAt: d.createdAt,
        })),
      };
    } catch (error: any) {
      throw new HttpException(
        `Failed to get delivery history: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/webhooks/events
   * Get available webhook event types
   */
  @Get('events/types')
  getEventTypes() {
    return {
      success: true,
      eventTypes: Object.values(WebhookEventType).map((type) => ({
        type,
        description: this.getEventDescription(type),
      })),
    };
  }

  /**
   * Format webhook for response (without secret)
   */
  private formatWebhook(webhook: any) {
    return {
      id: webhook.id,
      tenantId: webhook.tenantId,
      url: webhook.url,
      events: webhook.events,
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
    };
  }

  /**
   * Format webhook with secret (only for create)
   */
  private formatWebhookWithSecret(webhook: any) {
    return {
      ...this.formatWebhook(webhook),
      secret: webhook.secret,
    };
  }

  /**
   * Get human-readable event description
   */
  private getEventDescription(eventType: WebhookEventType): string {
    const descriptions: Record<WebhookEventType, string> = {
      [WebhookEventType.APPROVAL_REQUESTED]: 'Sent when a high-risk action requires approval',
      [WebhookEventType.APPROVAL_APPROVED]: 'Sent when an action is approved',
      [WebhookEventType.APPROVAL_REJECTED]: 'Sent when an action is rejected',
      [WebhookEventType.APPROVAL_EXPIRED]: 'Sent when an approval request expires',
    };
    return descriptions[eventType] || 'Unknown event type';
  }
}
