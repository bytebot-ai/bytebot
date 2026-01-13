/**
 * Git Integration Service
 * Phase 8 (v5.3.0): External Integrations - GitHub/GitLab webhook handling
 *
 * Features:
 * - GitHub webhook verification (HMAC-SHA256)
 * - GitLab webhook verification (secret token)
 * - Event processing (push, pull_request, merge_request)
 * - Goal run triggering from Git events
 * - Repository management
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { PrismaService } from './prisma.service';
import { GoalRunService } from './goal-run.service';

/**
 * Git provider types
 */
export enum GitProvider {
  GITHUB = 'GITHUB',
  GITLAB = 'GITLAB',
}

/**
 * Git event types we support
 */
export enum GitEventType {
  // GitHub events
  PUSH = 'push',
  PULL_REQUEST = 'pull_request',
  PULL_REQUEST_REVIEW = 'pull_request_review',
  ISSUES = 'issues',
  ISSUE_COMMENT = 'issue_comment',
  RELEASE = 'release',
  WORKFLOW_RUN = 'workflow_run',
  // GitLab events
  MERGE_REQUEST = 'merge_request',
  PIPELINE = 'pipeline',
  TAG_PUSH = 'tag_push',
  NOTE = 'note',
}

/**
 * Git event actions
 */
export enum GitEventAction {
  OPENED = 'opened',
  CLOSED = 'closed',
  MERGED = 'merged',
  REOPENED = 'reopened',
  SYNCHRONIZE = 'synchronize',
  CREATED = 'created',
  EDITED = 'edited',
  DELETED = 'deleted',
  APPROVED = 'approved',
  CHANGES_REQUESTED = 'changes_requested',
  PUBLISHED = 'published',
  COMPLETED = 'completed',
  SUCCESS = 'success',
  FAILED = 'failed',
}

/**
 * Trigger configuration for goal runs
 */
interface TriggerConfig {
  enabled: boolean;
  events: string[];
  branches?: string[];
  paths?: string[];
  goalTemplateId?: string;
  goalPattern?: string;
  constraints?: Record<string, any>;
  variableMapping?: Record<string, string>;
}

/**
 * Parsed webhook event
 */
interface ParsedGitEvent {
  provider: GitProvider;
  eventType: string;
  eventAction?: string;
  repository: {
    owner: string;
    name: string;
    fullName: string;
    url: string;
  };
  ref?: string;
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prTitle?: string;
  prBody?: string;
  sender: {
    login: string;
    avatarUrl?: string;
  };
  payload: Record<string, any>;
}

/**
 * Integration creation params
 */
interface CreateIntegrationParams {
  tenantId: string;
  provider: GitProvider;
  name: string;
  owner: string;
  repository: string;
  branch?: string;
  webhookSecret: string;
  subscribedEvents: string[];
  triggerConfig: TriggerConfig;
}

@Injectable()
export class GitIntegrationService {
  private readonly logger = new Logger(GitIntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly goalRunService: GoalRunService,
  ) {
    this.logger.log('GitIntegrationService initialized');
  }

  /**
   * Create a new Git integration
   */
  async createIntegration(params: CreateIntegrationParams) {
    const {
      tenantId,
      provider,
      name,
      owner,
      repository,
      branch = 'main',
      webhookSecret,
      subscribedEvents,
      triggerConfig,
    } = params;

    // Generate a unique webhook ID for routing
    const webhookId = crypto.randomUUID();

    const integration = await this.prisma.gitIntegration.create({
      data: {
        tenantId,
        provider,
        name,
        owner,
        repository,
        branch,
        webhookId,
        webhookSecret,
        subscribedEvents,
        triggerConfig: triggerConfig as any,
        enabled: true,
      },
    });

    this.logger.log(
      `Created ${provider} integration ${integration.id} for ${owner}/${repository}`,
    );

    return {
      integration,
      webhookUrl: this.getWebhookUrl(integration.id),
    };
  }

  /**
   * Get webhook URL for an integration
   */
  getWebhookUrl(integrationId: string): string {
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:8080';
    return `${baseUrl}/api/v1/git/webhooks/${integrationId}`;
  }

  /**
   * Update an integration
   */
  async updateIntegration(
    integrationId: string,
    updates: Partial<{
      name: string;
      branch: string;
      subscribedEvents: string[];
      triggerConfig: TriggerConfig;
      enabled: boolean;
    }>,
  ) {
    const integration = await this.prisma.gitIntegration.update({
      where: { id: integrationId },
      data: {
        ...(updates.name && { name: updates.name }),
        ...(updates.branch && { branch: updates.branch }),
        ...(updates.subscribedEvents && {
          subscribedEvents: updates.subscribedEvents,
        }),
        ...(updates.triggerConfig && {
          triggerConfig: updates.triggerConfig as any,
        }),
        ...(updates.enabled !== undefined && { enabled: updates.enabled }),
      },
    });

    this.logger.log(`Updated Git integration ${integrationId}`);
    return integration;
  }

  /**
   * Delete an integration
   */
  async deleteIntegration(integrationId: string) {
    await this.prisma.gitIntegration.delete({
      where: { id: integrationId },
    });

    this.logger.log(`Deleted Git integration ${integrationId}`);
  }

  /**
   * Get integration by ID
   */
  async getIntegration(integrationId: string) {
    return this.prisma.gitIntegration.findUnique({
      where: { id: integrationId },
      include: {
        events: {
          orderBy: { receivedAt: 'desc' },
          take: 10,
        },
      },
    });
  }

  /**
   * List integrations for a tenant
   */
  async listIntegrations(
    tenantId: string,
    options: { limit?: number; offset?: number; provider?: GitProvider } = {},
  ) {
    const { limit = 20, offset = 0, provider } = options;

    const where = {
      tenantId,
      ...(provider && { provider }),
    };

    const [integrations, total] = await Promise.all([
      this.prisma.gitIntegration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.gitIntegration.count({ where }),
    ]);

    return {
      integrations,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + integrations.length < total,
      },
    };
  }

  /**
   * Verify GitHub webhook signature
   */
  verifyGitHubSignature(
    payload: string,
    signature: string,
    secret: string,
  ): boolean {
    if (!signature || !signature.startsWith('sha256=')) {
      return false;
    }

    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  }

  /**
   * Verify GitLab webhook token
   */
  verifyGitLabToken(token: string, secret: string): boolean {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  }

  /**
   * Process incoming webhook
   */
  async processWebhook(
    integrationId: string,
    headers: Record<string, string>,
    rawPayload: string,
    parsedPayload: Record<string, any>,
  ): Promise<{ success: boolean; eventId?: string; goalRunId?: string; error?: string }> {
    // Get the integration
    const integration = await this.prisma.gitIntegration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      return { success: false, error: 'Integration not found' };
    }

    if (!integration.enabled) {
      return { success: false, error: 'Integration is disabled' };
    }

    // Verify signature based on provider
    const isValid =
      integration.provider === GitProvider.GITHUB
        ? this.verifyGitHubSignature(
            rawPayload,
            headers['x-hub-signature-256'] || '',
            integration.webhookSecret || '',
          )
        : this.verifyGitLabToken(
            headers['x-gitlab-token'] || '',
            integration.webhookSecret || '',
          );

    if (!isValid) {
      this.logger.warn(
        `Invalid webhook signature for integration ${integrationId}`,
      );
      return { success: false, error: 'Invalid signature' };
    }

    // Parse the event
    const event = this.parseWebhookEvent(
      integration.provider as GitProvider,
      headers,
      parsedPayload,
    );

    // Check if we're subscribed to this event
    if (!integration.subscribedEvents.includes(event.eventType)) {
      this.logger.debug(
        `Ignoring unsubscribed event ${event.eventType} for integration ${integrationId}`,
      );
      return { success: true, error: 'Event not subscribed' };
    }

    // Store the event
    const storedEvent = await this.prisma.gitIntegrationEvent.create({
      data: {
        integrationId,
        eventType: event.eventType,
        eventAction: event.eventAction,
        ref: event.ref,
        commitSha: event.commitSha,
        prNumber: event.prNumber,
        payload: event.payload as any,
        processed: false,
      },
    });

    // Check if we should trigger a goal run
    const triggerConfig = integration.triggerConfig as unknown as TriggerConfig;

    if (triggerConfig?.enabled && this.shouldTriggerGoalRun(event, triggerConfig)) {
      try {
        const goalRunId = await this.triggerGoalRun(
          integration.tenantId,
          event,
          triggerConfig,
        );

        // Update event with goal run ID
        await this.prisma.gitIntegrationEvent.update({
          where: { id: storedEvent.id },
          data: {
            processed: true,
            goalRunId,
          },
        });

        this.logger.log(
          `Triggered goal run ${goalRunId} from ${event.eventType} event`,
        );

        return {
          success: true,
          eventId: storedEvent.id,
          goalRunId,
        };
      } catch (error: any) {
        this.logger.error(
          `Failed to trigger goal run from event: ${error.message}`,
        );

        await this.prisma.gitIntegrationEvent.update({
          where: { id: storedEvent.id },
          data: {
            processed: true,
            error: error.message,
          },
        });

        return {
          success: false,
          eventId: storedEvent.id,
          error: error.message,
        };
      }
    }

    // Mark as processed even if no goal run triggered
    await this.prisma.gitIntegrationEvent.update({
      where: { id: storedEvent.id },
      data: { processed: true },
    });

    // Emit event for other listeners
    this.eventEmitter.emit('git.event', {
      integrationId,
      event,
      eventId: storedEvent.id,
    });

    return {
      success: true,
      eventId: storedEvent.id,
    };
  }

  /**
   * Parse webhook event from payload
   */
  private parseWebhookEvent(
    provider: GitProvider,
    headers: Record<string, string>,
    payload: Record<string, any>,
  ): ParsedGitEvent {
    if (provider === GitProvider.GITHUB) {
      return this.parseGitHubEvent(headers, payload);
    } else {
      return this.parseGitLabEvent(headers, payload);
    }
  }

  /**
   * Parse GitHub webhook event
   */
  private parseGitHubEvent(
    headers: Record<string, string>,
    payload: Record<string, any>,
  ): ParsedGitEvent {
    const eventType = headers['x-github-event'] || 'unknown';
    const repo = payload.repository || {};

    let branch: string | undefined;
    let commitSha: string | undefined;
    let prNumber: number | undefined;
    let prTitle: string | undefined;
    let prBody: string | undefined;

    // Extract branch/ref info based on event type
    if (eventType === 'push') {
      const ref = payload.ref || '';
      branch = ref.replace('refs/heads/', '');
      commitSha = payload.after || payload.head_commit?.id;
    } else if (eventType === 'pull_request') {
      prNumber = payload.pull_request?.number;
      prTitle = payload.pull_request?.title;
      prBody = payload.pull_request?.body;
      branch = payload.pull_request?.head?.ref;
      commitSha = payload.pull_request?.head?.sha;
    }

    return {
      provider: GitProvider.GITHUB,
      eventType,
      eventAction: payload.action,
      repository: {
        owner: repo.owner?.login || '',
        name: repo.name || '',
        fullName: repo.full_name || '',
        url: repo.html_url || '',
      },
      ref: payload.ref,
      branch,
      commitSha,
      prNumber,
      prTitle,
      prBody,
      sender: {
        login: payload.sender?.login || '',
        avatarUrl: payload.sender?.avatar_url,
      },
      payload,
    };
  }

  /**
   * Parse GitLab webhook event
   */
  private parseGitLabEvent(
    headers: Record<string, string>,
    payload: Record<string, any>,
  ): ParsedGitEvent {
    const eventType = payload.object_kind || headers['x-gitlab-event'] || 'unknown';
    const project = payload.project || {};

    let branch: string | undefined;
    let commitSha: string | undefined;
    let prNumber: number | undefined;
    let prTitle: string | undefined;
    let prBody: string | undefined;

    // Extract info based on event type
    if (eventType === 'push') {
      const ref = payload.ref || '';
      branch = ref.replace('refs/heads/', '');
      commitSha = payload.after || payload.checkout_sha;
    } else if (eventType === 'merge_request') {
      const mr = payload.object_attributes || {};
      prNumber = mr.iid;
      prTitle = mr.title;
      prBody = mr.description;
      branch = mr.source_branch;
      commitSha = mr.last_commit?.id;
    }

    return {
      provider: GitProvider.GITLAB,
      eventType,
      eventAction: payload.object_attributes?.action,
      repository: {
        owner: project.namespace || '',
        name: project.name || '',
        fullName: project.path_with_namespace || '',
        url: project.web_url || '',
      },
      ref: payload.ref,
      branch,
      commitSha,
      prNumber,
      prTitle,
      prBody,
      sender: {
        login: payload.user?.username || payload.user_username || '',
        avatarUrl: payload.user?.avatar_url,
      },
      payload,
    };
  }

  /**
   * Check if event should trigger a goal run
   */
  private shouldTriggerGoalRun(
    event: ParsedGitEvent,
    config: TriggerConfig,
  ): boolean {
    // Check if event type matches
    const eventKey = event.eventAction
      ? `${event.eventType}:${event.eventAction}`
      : event.eventType;

    const eventMatches = config.events.some((e) => {
      if (e === eventKey) return true;
      if (e === event.eventType) return true;
      if (e.includes('*')) {
        const regex = new RegExp('^' + e.replace('*', '.*') + '$');
        return regex.test(eventKey);
      }
      return false;
    });

    if (!eventMatches) {
      return false;
    }

    // Check branch filter
    if (config.branches && config.branches.length > 0 && event.branch) {
      const branchMatches = config.branches.some((b) => {
        if (b === event.branch) return true;
        if (b.includes('*')) {
          const regex = new RegExp('^' + b.replace('*', '.*') + '$');
          return regex.test(event.branch!);
        }
        return false;
      });

      if (!branchMatches) {
        return false;
      }
    }

    // Check path filters (for push events)
    if (config.paths && config.paths.length > 0 && event.payload.commits) {
      const modifiedFiles = new Set<string>();
      for (const commit of event.payload.commits) {
        (commit.added || []).forEach((f: string) => modifiedFiles.add(f));
        (commit.modified || []).forEach((f: string) => modifiedFiles.add(f));
        (commit.removed || []).forEach((f: string) => modifiedFiles.add(f));
      }

      const pathMatches = config.paths.some((p) => {
        const regex = new RegExp('^' + p.replace('**', '.*').replace('*', '[^/]*') + '$');
        return Array.from(modifiedFiles).some((f) => regex.test(f));
      });

      if (!pathMatches) {
        return false;
      }
    }

    return true;
  }

  /**
   * Trigger a goal run from Git event
   */
  private async triggerGoalRun(
    tenantId: string,
    event: ParsedGitEvent,
    config: TriggerConfig,
  ): Promise<string> {
    // Build goal text from pattern or template
    let goal = config.goalPattern || '';

    // Replace variables in goal pattern
    const variables: Record<string, string> = {
      repo: event.repository.fullName,
      owner: event.repository.owner,
      repository: event.repository.name,
      branch: event.branch || '',
      commit: event.commitSha || '',
      pr_number: event.prNumber?.toString() || '',
      pr_title: event.prTitle || '',
      sender: event.sender.login,
      event_type: event.eventType,
      event_action: event.eventAction || '',
    };

    // Apply variable mapping if provided
    if (config.variableMapping) {
      for (const [key, path] of Object.entries(config.variableMapping)) {
        const value = this.getNestedValue(event.payload, path);
        if (value !== undefined) {
          variables[key] = String(value);
        }
      }
    }

    // Replace {{variable}} patterns
    goal = goal.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '');

    // Include git event info in goal text for context
    const goalWithContext = `${goal}\n\n[Git Event: ${event.provider} ${event.eventType}${event.eventAction ? ':' + event.eventAction : ''} on ${event.repository.fullName}${event.branch ? ' branch ' + event.branch : ''}${event.commitSha ? ' commit ' + event.commitSha.substring(0, 7) : ''}]`;

    // Create the goal run
    const goalRun = await this.goalRunService.createFromGoal({
      tenantId,
      goal: goalWithContext,
      constraints: config.constraints || {},
      autoStart: true,
    });

    return goalRun.id;
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: Record<string, any>, path: string): any {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
  }

  /**
   * Rotate webhook secret for an integration
   */
  async rotateWebhookSecret(integrationId: string): Promise<{ secret: string }> {
    const newSecret = crypto.randomBytes(32).toString('hex');

    await this.prisma.gitIntegration.update({
      where: { id: integrationId },
      data: { webhookSecret: newSecret },
    });

    this.logger.log(`Rotated webhook secret for integration ${integrationId}`);

    return { secret: newSecret };
  }

  /**
   * Get event history for an integration
   */
  async getEventHistory(
    integrationId: string,
    options: { limit?: number; offset?: number } = {},
  ) {
    const { limit = 50, offset = 0 } = options;

    const [events, total] = await Promise.all([
      this.prisma.gitIntegrationEvent.findMany({
        where: { integrationId },
        orderBy: { receivedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.gitIntegrationEvent.count({ where: { integrationId } }),
    ]);

    return {
      events,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + events.length < total,
      },
    };
  }

  /**
   * Test an integration by sending a ping
   */
  async testIntegration(integrationId: string): Promise<{ success: boolean; message: string }> {
    const integration = await this.prisma.gitIntegration.findUnique({
      where: { id: integrationId },
    });

    if (!integration) {
      return { success: false, message: 'Integration not found' };
    }

    // Just verify the configuration is valid
    return {
      success: true,
      message: `Integration ${integration.name} is configured for ${integration.provider} repository ${integration.owner}/${integration.repository}`,
    };
  }
}
