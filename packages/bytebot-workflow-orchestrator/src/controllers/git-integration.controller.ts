/**
 * Git Integration Controller
 * Phase 8 (v5.3.0): External Integrations - GitHub/GitLab webhook management
 *
 * Endpoints:
 * - GET    /api/v1/git/integrations              List integrations for tenant
 * - POST   /api/v1/git/integrations              Create Git integration
 * - GET    /api/v1/git/integrations/:id          Get integration details
 * - PUT    /api/v1/git/integrations/:id          Update integration
 * - DELETE /api/v1/git/integrations/:id          Delete integration
 * - POST   /api/v1/git/integrations/:id/test     Test integration
 * - POST   /api/v1/git/integrations/:id/rotate   Rotate webhook secret
 * - GET    /api/v1/git/integrations/:id/events   Get event history
 * - POST   /api/v1/git/webhooks/:id              Receive webhook from GitHub/GitLab
 * - GET    /api/v1/git/providers                 Get available providers
 * - GET    /api/v1/git/events                    Get available event types
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
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiQuery,
} from '@nestjs/swagger';
import { Request } from 'express';
import {
  GitIntegrationService,
  GitProvider,
  GitEventType,
} from '../services/git-integration.service';

/**
 * DTOs for Git integration endpoints
 */
interface CreateIntegrationDto {
  provider: GitProvider;
  name: string;
  owner: string;
  repository: string;
  branch?: string;
  subscribedEvents: string[];
  triggerConfig: {
    enabled: boolean;
    events: string[];
    branches?: string[];
    paths?: string[];
    goalTemplateId?: string;
    goalPattern?: string;
    constraints?: Record<string, any>;
    variableMapping?: Record<string, string>;
  };
}

interface UpdateIntegrationDto {
  name?: string;
  branch?: string;
  subscribedEvents?: string[];
  triggerConfig?: {
    enabled?: boolean;
    events?: string[];
    branches?: string[];
    paths?: string[];
    goalTemplateId?: string;
    goalPattern?: string;
    constraints?: Record<string, any>;
    variableMapping?: Record<string, string>;
  };
  enabled?: boolean;
}

interface ListIntegrationsQuery {
  provider?: GitProvider;
  limit?: string;
  offset?: string;
}

@ApiTags('git')
@Controller('git')
export class GitIntegrationController {
  private readonly logger = new Logger(GitIntegrationController.name);

  constructor(private readonly gitService: GitIntegrationService) {}

  /**
   * GET /api/v1/git/integrations
   * List Git integrations for a tenant
   */
  @Get('integrations')
  @ApiOperation({ summary: 'List Git integrations' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiQuery({ name: 'provider', required: false, enum: GitProvider })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Integrations retrieved successfully' })
  async listIntegrations(
    @Query() query: ListIntegrationsQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const limit = parseInt(query.limit || '20', 10);
    const offset = parseInt(query.offset || '0', 10);

    const result = await this.gitService.listIntegrations(tenantId, {
      limit,
      offset,
      provider: query.provider,
    });

    return {
      success: true,
      integrations: result.integrations.map((i) => this.formatIntegration(i)),
      pagination: result.pagination,
    };
  }

  /**
   * POST /api/v1/git/integrations
   * Create a new Git integration
   */
  @Post('integrations')
  @ApiOperation({ summary: 'Create Git integration' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 201, description: 'Integration created successfully' })
  async createIntegration(
    @Body() body: CreateIntegrationDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Validate required fields
    if (!body.provider) {
      throw new HttpException('provider is required', HttpStatus.BAD_REQUEST);
    }

    if (!Object.values(GitProvider).includes(body.provider)) {
      throw new HttpException(
        `Invalid provider. Valid providers: ${Object.values(GitProvider).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!body.name) {
      throw new HttpException('name is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.owner) {
      throw new HttpException('owner is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.repository) {
      throw new HttpException('repository is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.subscribedEvents || body.subscribedEvents.length === 0) {
      throw new HttpException('subscribedEvents array is required', HttpStatus.BAD_REQUEST);
    }

    // Generate webhook secret
    const crypto = await import('crypto');
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    try {
      const result = await this.gitService.createIntegration({
        tenantId,
        provider: body.provider,
        name: body.name,
        owner: body.owner,
        repository: body.repository,
        branch: body.branch,
        webhookSecret,
        subscribedEvents: body.subscribedEvents,
        triggerConfig: body.triggerConfig,
      });

      this.logger.log(
        `Created ${body.provider} integration ${result.integration.id} for ${body.owner}/${body.repository}`,
      );

      return {
        success: true,
        integration: this.formatIntegrationWithSecret(result.integration, webhookSecret),
        webhookUrl: result.webhookUrl,
        message: `Integration created successfully. Configure your ${body.provider} webhook to send events to the webhookUrl. Save the webhookSecret - it will not be shown again.`,
      };
    } catch (error: any) {
      this.logger.error(`Failed to create Git integration: ${error.message}`);
      throw new HttpException(
        `Failed to create integration: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/git/integrations/:id
   * Get integration details
   */
  @Get('integrations/:id')
  @ApiOperation({ summary: 'Get Git integration details' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Integration retrieved successfully' })
  async getIntegration(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const integration = await this.gitService.getIntegration(id);

    if (!integration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    if (integration.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    // Cast to any to access included events relation
    const integrationWithEvents = integration as any;

    return {
      success: true,
      integration: this.formatIntegration(integration),
      webhookUrl: this.gitService.getWebhookUrl(id),
      recentEvents: integrationWithEvents.events?.map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        eventAction: e.eventAction,
        ref: e.ref,
        commitSha: e.commitSha,
        prNumber: e.prNumber,
        processed: e.processed,
        goalRunId: e.goalRunId,
        error: e.error,
        receivedAt: e.receivedAt,
      })),
    };
  }

  /**
   * PUT /api/v1/git/integrations/:id
   * Update Git integration
   */
  @Put('integrations/:id')
  @ApiOperation({ summary: 'Update Git integration' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Integration updated successfully' })
  async updateIntegration(
    @Param('id') id: string,
    @Body() body: UpdateIntegrationDto,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify integration belongs to tenant
    const existing = await this.gitService.getIntegration(id);

    if (!existing || existing.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    try {
      const integration = await this.gitService.updateIntegration(id, {
        name: body.name,
        branch: body.branch,
        subscribedEvents: body.subscribedEvents,
        triggerConfig: body.triggerConfig as any,
        enabled: body.enabled,
      });

      this.logger.log(`Updated Git integration ${id}`);

      return {
        success: true,
        integration: this.formatIntegration(integration),
        message: 'Integration updated successfully',
      };
    } catch (error: any) {
      this.logger.error(`Failed to update integration ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to update integration: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * DELETE /api/v1/git/integrations/:id
   * Delete Git integration
   */
  @Delete('integrations/:id')
  @ApiOperation({ summary: 'Delete Git integration' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Integration deleted successfully' })
  async deleteIntegration(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify integration belongs to tenant
    const existing = await this.gitService.getIntegration(id);

    if (!existing || existing.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    try {
      await this.gitService.deleteIntegration(id);

      this.logger.log(`Deleted Git integration ${id}`);

      return {
        success: true,
        message: 'Integration deleted successfully. Remember to remove the webhook from your Git provider.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to delete integration ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to delete integration: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/git/integrations/:id/test
   * Test Git integration
   */
  @Post('integrations/:id/test')
  @ApiOperation({ summary: 'Test Git integration configuration' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Integration test result' })
  async testIntegration(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify integration belongs to tenant
    const existing = await this.gitService.getIntegration(id);

    if (!existing || existing.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    const result = await this.gitService.testIntegration(id);

    return {
      success: result.success,
      message: result.message,
    };
  }

  /**
   * POST /api/v1/git/integrations/:id/rotate
   * Rotate webhook secret
   */
  @Post('integrations/:id/rotate')
  @ApiOperation({ summary: 'Rotate webhook secret' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiResponse({ status: 200, description: 'Secret rotated successfully' })
  async rotateSecret(
    @Param('id') id: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify integration belongs to tenant
    const existing = await this.gitService.getIntegration(id);

    if (!existing || existing.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    try {
      const result = await this.gitService.rotateWebhookSecret(id);

      this.logger.log(`Rotated webhook secret for integration ${id}`);

      return {
        success: true,
        webhookSecret: result.secret,
        message: 'Webhook secret rotated. Update your Git provider webhook configuration with the new secret.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to rotate secret for integration ${id}: ${error.message}`);
      throw new HttpException(
        `Failed to rotate secret: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/git/integrations/:id/events
   * Get event history
   */
  @Get('integrations/:id/events')
  @ApiOperation({ summary: 'Get Git integration event history' })
  @ApiHeader({ name: 'X-Tenant-Id', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Events retrieved successfully' })
  async getEvents(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    // Verify integration belongs to tenant
    const existing = await this.gitService.getIntegration(id);

    if (!existing || existing.tenantId !== tenantId) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }

    const result = await this.gitService.getEventHistory(id, {
      limit: parseInt(limit || '50', 10),
      offset: parseInt(offset || '0', 10),
    });

    return {
      success: true,
      events: result.events.map((e: any) => ({
        id: e.id,
        eventType: e.eventType,
        eventAction: e.eventAction,
        ref: e.ref,
        commitSha: e.commitSha,
        prNumber: e.prNumber,
        processed: e.processed,
        goalRunId: e.goalRunId,
        error: e.error,
        createdAt: e.createdAt,
      })),
      pagination: result.pagination,
    };
  }

  /**
   * POST /api/v1/git/webhooks/:id
   * Receive webhook from GitHub/GitLab
   * This endpoint is called by the Git provider when events occur
   */
  @Post('webhooks/:id')
  @ApiOperation({ summary: 'Receive webhook from Git provider (GitHub/GitLab)' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async receiveWebhook(
    @Param('id') id: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, any>,
    @Headers() headers: Record<string, string>,
  ) {
    // Get raw body for signature verification
    const rawBody = req.rawBody?.toString() || JSON.stringify(body);

    try {
      const result = await this.gitService.processWebhook(
        id,
        headers,
        rawBody,
        body,
      );

      if (result.success) {
        return {
          success: true,
          eventId: result.eventId,
          goalRunId: result.goalRunId,
          message: result.goalRunId
            ? 'Webhook processed and goal run triggered'
            : 'Webhook processed',
        };
      } else {
        // Return 200 for invalid signature to not leak info
        // but include error in response
        return {
          success: false,
          error: result.error,
        };
      }
    } catch (error: any) {
      this.logger.error(`Webhook processing error: ${error.message}`);
      // Always return 200 to Git providers to prevent retries
      return {
        success: false,
        error: 'Internal processing error',
      };
    }
  }

  /**
   * GET /api/v1/git/providers
   * Get available Git providers
   */
  @Get('providers')
  @ApiOperation({ summary: 'Get available Git providers' })
  @ApiResponse({ status: 200, description: 'Providers retrieved' })
  getProviders() {
    return {
      success: true,
      providers: [
        {
          provider: GitProvider.GITHUB,
          name: 'GitHub',
          description: 'GitHub repositories and organizations',
          webhookSetup: {
            url: 'Settings > Webhooks > Add webhook',
            contentType: 'application/json',
            signatureHeader: 'X-Hub-Signature-256',
            events: [
              'push',
              'pull_request',
              'pull_request_review',
              'issues',
              'issue_comment',
              'release',
              'workflow_run',
            ],
          },
        },
        {
          provider: GitProvider.GITLAB,
          name: 'GitLab',
          description: 'GitLab repositories and groups',
          webhookSetup: {
            url: 'Settings > Webhooks',
            contentType: 'application/json',
            signatureHeader: 'X-Gitlab-Token',
            events: [
              'push',
              'merge_request',
              'pipeline',
              'tag_push',
              'note',
            ],
          },
        },
      ],
    };
  }

  /**
   * GET /api/v1/git/events
   * Get available Git event types
   */
  @Get('events')
  @ApiOperation({ summary: 'Get available Git event types' })
  @ApiResponse({ status: 200, description: 'Event types retrieved' })
  getEventTypes() {
    return {
      success: true,
      events: {
        github: [
          { type: 'push', description: 'Push to repository' },
          { type: 'pull_request', description: 'Pull request events', actions: ['opened', 'closed', 'merged', 'synchronize', 'reopened'] },
          { type: 'pull_request_review', description: 'PR review events', actions: ['submitted', 'approved', 'changes_requested'] },
          { type: 'issues', description: 'Issue events', actions: ['opened', 'closed', 'edited'] },
          { type: 'issue_comment', description: 'Issue/PR comments', actions: ['created', 'edited'] },
          { type: 'release', description: 'Release events', actions: ['published', 'created'] },
          { type: 'workflow_run', description: 'GitHub Actions workflow', actions: ['completed', 'requested'] },
        ],
        gitlab: [
          { type: 'push', description: 'Push to repository' },
          { type: 'merge_request', description: 'Merge request events', actions: ['open', 'close', 'merge', 'update'] },
          { type: 'pipeline', description: 'CI/CD pipeline events', actions: ['pending', 'running', 'success', 'failed'] },
          { type: 'tag_push', description: 'Tag push events' },
          { type: 'note', description: 'Comment events' },
        ],
      },
    };
  }

  /**
   * Format integration for response (hide sensitive data)
   */
  private formatIntegration(integration: any) {
    return {
      id: integration.id,
      tenantId: integration.tenantId,
      provider: integration.provider,
      name: integration.name,
      owner: integration.owner,
      repository: integration.repository,
      branch: integration.branch,
      webhookId: integration.webhookId,
      subscribedEvents: integration.subscribedEvents,
      triggerConfig: integration.triggerConfig,
      enabled: integration.enabled,
      createdAt: integration.createdAt,
      updatedAt: integration.updatedAt,
    };
  }

  /**
   * Format integration with secret (only for create)
   */
  private formatIntegrationWithSecret(integration: any, secret: string) {
    return {
      ...this.formatIntegration(integration),
      webhookSecret: secret,
    };
  }
}
