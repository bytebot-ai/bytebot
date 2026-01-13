/**
 * Slack Notification Service
 * Phase 8: External Integrations
 *
 * Sends notifications to Slack via Incoming Webhooks.
 * Uses Block Kit for rich message formatting.
 *
 * Features:
 * - Rich Block Kit message formatting
 * - Goal run notifications (started, completed, failed)
 * - Batch progress notifications
 * - Approval request notifications with action buttons
 * - Configurable per-channel settings
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import * as crypto from 'crypto';

// Slack configuration interface
export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

// Slack Block Kit block types
interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  fields?: Array<{
    type: string;
    text: string;
  }>;
  accessory?: any;
  elements?: any[];
  block_id?: string;
}

// Slack message payload
interface SlackMessage {
  text: string; // Fallback text for notifications
  blocks?: SlackBlock[];
  attachments?: Array<{
    color?: string;
    blocks?: SlackBlock[];
  }>;
  channel?: string;
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

// Event types supported by Slack notifications
export enum SlackEventType {
  GOAL_STARTED = 'goal.started',
  GOAL_COMPLETED = 'goal.completed',
  GOAL_FAILED = 'goal.failed',
  GOAL_CANCELLED = 'goal.cancelled',
  BATCH_STARTED = 'batch.started',
  BATCH_PROGRESS = 'batch.progress',
  BATCH_COMPLETED = 'batch.completed',
  BATCH_FAILED = 'batch.failed',
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_APPROVED = 'approval.approved',
  APPROVAL_REJECTED = 'approval.rejected',
  APPROVAL_EXPIRED = 'approval.expired',
  USER_PROMPT_CREATED = 'user_prompt.created',
  USER_PROMPT_RESOLVED = 'user_prompt.resolved',
}

// Event data interfaces
export interface GoalEventData {
  goalRunId: string;
  tenantId: string;
  goal: string;
  status: string;
  phase?: string;
  templateName?: string;
  duration?: number; // milliseconds
  error?: string;
  stepsCompleted?: number;
  totalSteps?: number;
  links?: {
    goalRun?: string;
  };
}

export interface BatchEventData {
  batchId: string;
  tenantId: string;
  name: string;
  status: string;
  totalGoals: number;
  completedGoals: number;
  failedGoals: number;
  progress: number;
  links?: {
    batch?: string;
  };
}

export interface ApprovalEventData {
  approvalId: string;
  tenantId: string;
  toolName: string;
  riskLevel: string;
  summary: string;
  decision?: {
    status: string;
    reviewerId?: string;
    reason?: string;
  };
  links?: {
    approval?: string;
  };
}

export interface UserPromptEventData {
  promptId: string;
  tenantId: string;
  goalRunId: string;
  checklistItemId: string | null;
  kind: string;
  stepDescription?: string | null;
  links?: {
    goalRun?: string;
    prompt?: string;
    desktopTakeover?: string | null;
  };
}

// Delivery result
export interface SlackDeliveryResult {
  success: boolean;
  channelId: string;
  eventId: string;
  statusCode?: number;
  error?: string;
  attempts: number;
  deliveredAt?: Date;
}

// Retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

@Injectable()
export class SlackNotificationService {
  private readonly logger = new Logger(SlackNotificationService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'APP_BASE_URL',
      'https://app.bytebot.ai',
    );
    this.timeoutMs = parseInt(
      this.configService.get<string>('SLACK_TIMEOUT_MS', '10000'),
      10,
    );
    this.logger.log('SlackNotificationService initialized');
  }

  /**
   * Send a goal event notification
   */
  async sendGoalNotification(
    eventType: SlackEventType,
    data: GoalEventData,
  ): Promise<SlackDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Slack channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const message = this.buildGoalMessage(eventType, data);
    return this.deliverToChannels(channels, eventType, message);
  }

  /**
   * Send a batch event notification
   */
  async sendBatchNotification(
    eventType: SlackEventType,
    data: BatchEventData,
  ): Promise<SlackDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Slack channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const message = this.buildBatchMessage(eventType, data);
    return this.deliverToChannels(channels, eventType, message);
  }

  /**
   * Send an approval event notification
   */
  async sendApprovalNotification(
    eventType: SlackEventType,
    data: ApprovalEventData,
  ): Promise<SlackDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Slack channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const message = this.buildApprovalMessage(eventType, data);
    return this.deliverToChannels(channels, eventType, message);
  }

  /**
   * Send a user prompt notification (durable WAIT surface)
   */
  async sendUserPromptNotification(
    eventType: SlackEventType,
    data: UserPromptEventData,
    options?: { eventId?: string },
  ): Promise<SlackDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Slack channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const message = this.buildUserPromptMessage(eventType, data);
    return this.deliverToChannels(channels, eventType, message, options);
  }

  /**
   * Build Slack message for goal events
   */
  private buildGoalMessage(eventType: SlackEventType, data: GoalEventData): SlackMessage {
    const { emoji, color, title } = this.getGoalEventStyle(eventType);

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Goal:* ${this.truncateText(data.goal, 200)}`,
        },
      },
    ];

    // Add details fields
    const fields: Array<{ type: string; text: string }> = [
      { type: 'mrkdwn', text: `*Status:* ${data.status}` },
    ];

    if (data.phase) {
      fields.push({ type: 'mrkdwn', text: `*Phase:* ${data.phase}` });
    }

    if (data.templateName) {
      fields.push({ type: 'mrkdwn', text: `*Template:* ${data.templateName}` });
    }

    if (data.duration) {
      fields.push({
        type: 'mrkdwn',
        text: `*Duration:* ${this.formatDuration(data.duration)}`,
      });
    }

    if (data.stepsCompleted !== undefined) {
      fields.push({
        type: 'mrkdwn',
        text: `*Steps:* ${data.stepsCompleted}/${data.totalSteps || '?'}`,
      });
    }

    blocks.push({
      type: 'section',
      fields,
    });

    // Add error message for failed goals
    if (data.error && eventType === SlackEventType.GOAL_FAILED) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Error:*\n\`\`\`${this.truncateText(data.error, 500)}\`\`\``,
        },
      });
    }

    // Add action button
    if (data.links?.goalRun) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Goal Run',
              emoji: true,
            },
            url: data.links.goalRun,
            style: 'primary',
          },
        ],
      });
    }

    // Add timestamp
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Goal Run ID: \`${data.goalRunId}\` | ${new Date().toISOString()}`,
        },
      ],
    });

    return {
      text: `${emoji} ${title}: ${this.truncateText(data.goal, 100)}`,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };
  }

  /**
   * Build Slack message for batch events
   */
  private buildBatchMessage(eventType: SlackEventType, data: BatchEventData): SlackMessage {
    const { emoji, color, title } = this.getBatchEventStyle(eventType);

    const progressBar = this.buildProgressBar(data.progress);

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Batch:* ${data.name}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status:* ${data.status}` },
          { type: 'mrkdwn', text: `*Progress:* ${data.progress}%` },
          { type: 'mrkdwn', text: `*Completed:* ${data.completedGoals}/${data.totalGoals}` },
          { type: 'mrkdwn', text: `*Failed:* ${data.failedGoals}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: progressBar,
        },
      },
    ];

    if (data.links?.batch) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Batch',
              emoji: true,
            },
            url: data.links.batch,
            style: 'primary',
          },
        ],
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Batch ID: \`${data.batchId}\` | ${new Date().toISOString()}`,
        },
      ],
    });

    return {
      text: `${emoji} ${title}: ${data.name} (${data.progress}%)`,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };
  }

  /**
   * Build Slack message for approval events
   */
  private buildApprovalMessage(
    eventType: SlackEventType,
    data: ApprovalEventData,
  ): SlackMessage {
    const { emoji, color, title } = this.getApprovalEventStyle(eventType);

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Action:* ${data.summary}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tool:* ${data.toolName}` },
          { type: 'mrkdwn', text: `*Risk Level:* ${this.getRiskEmoji(data.riskLevel)} ${data.riskLevel}` },
        ],
      },
    ];

    // Add decision info for resolved approvals
    if (data.decision) {
      blocks.push({
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Decision:* ${data.decision.status}` },
          ...(data.decision.reviewerId
            ? [{ type: 'mrkdwn', text: `*Reviewer:* ${data.decision.reviewerId}` }]
            : []),
          ...(data.decision.reason
            ? [{ type: 'mrkdwn', text: `*Reason:* ${data.decision.reason}` }]
            : []),
        ],
      });
    }

    if (data.links?.approval) {
      const buttonStyle = eventType === SlackEventType.APPROVAL_REQUESTED ? 'danger' : 'primary';
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: eventType === SlackEventType.APPROVAL_REQUESTED ? 'Review & Approve' : 'View Details',
              emoji: true,
            },
            url: data.links.approval,
            style: buttonStyle,
          },
        ],
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Approval ID: \`${data.approvalId}\` | ${new Date().toISOString()}`,
        },
      ],
    });

    return {
      text: `${emoji} ${title}: ${data.summary}`,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };
  }

  /**
   * Get active Slack channels for a tenant and event type
   */
  private async getActiveChannels(
    tenantId: string,
    eventType: SlackEventType,
  ): Promise<Array<{ id: string; config: SlackConfig }>> {
    try {
      const channels = await this.prisma.notificationChannel.findMany({
        where: {
          tenantId,
          type: 'SLACK',
          enabled: true,
          events: {
            has: eventType,
          },
        },
      });

      return channels.map((c) => ({
        id: c.id,
        config: c.config as unknown as SlackConfig,
      }));
    } catch (error: any) {
      if (error.code === 'P2021' || error.message?.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Deliver message to multiple channels
   */
  private async deliverToChannels(
    channels: Array<{ id: string; config: SlackConfig }>,
    eventType: SlackEventType,
    message: SlackMessage,
    options?: { eventId?: string },
  ): Promise<SlackDeliveryResult[]> {
    const eventId = options?.eventId ?? this.generateEventId();
    const results: SlackDeliveryResult[] = [];

    for (const channel of channels) {
      const result = await this.deliverToChannel(channel, eventType, eventId, message);
      results.push(result);
      await this.recordDelivery(channel.id, eventId, eventType, result, message);
    }

    return results;
  }

  private buildUserPromptMessage(eventType: SlackEventType, data: UserPromptEventData): SlackMessage {
    const { emoji, color, title } = this.getUserPromptEventStyle(eventType);

    const goalRunLink = data.links?.goalRun || `${this.baseUrl}/goals/${data.goalRunId}`;
    const desktopTakeoverLink = data.links?.desktopTakeover || null;
    const checklistLabel = data.checklistItemId ? `Checklist Item: \`${data.checklistItemId}\`` : 'Checklist Item: (none)';

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Step:* ${this.truncateText(data.stepDescription || '(no description)', 200)}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Prompt Kind:* ${data.kind}` },
          { type: 'mrkdwn', text: `*Goal Run:* \`${data.goalRunId}\`` },
        ],
      },
    ];

    const actionElements: any[] = [];
    if (goalRunLink) {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Open Goal Run',
          emoji: true,
        },
        url: goalRunLink,
        style: eventType === SlackEventType.USER_PROMPT_CREATED ? 'primary' : 'default',
      });
    }
    if (desktopTakeoverLink) {
      actionElements.push({
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Take Over Desktop',
          emoji: true,
        },
        url: desktopTakeoverLink,
        style: 'primary',
      });
    }

    if (actionElements.length > 0) {
      blocks.push({
        type: 'actions',
        elements: actionElements,
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Prompt ID: \`${data.promptId}\` | ${checklistLabel} | ${new Date().toISOString()}`,
        },
      ],
    });

    return {
      text: `${title}: ${this.truncateText(data.stepDescription || 'User input required', 120)}`,
      attachments: [
        {
          color,
          blocks,
        },
      ],
    };
  }

  /**
   * Deliver message to a single channel with retry
   */
  private async deliverToChannel(
    channel: { id: string; config: SlackConfig },
    eventType: SlackEventType,
    eventId: string,
    message: SlackMessage,
  ): Promise<SlackDeliveryResult> {
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;
    let attempts = 0;

    // Apply channel-specific settings
    const finalMessage: SlackMessage = {
      ...message,
      channel: channel.config.channel || message.channel,
      username: channel.config.username || message.username || 'ByteBot',
      icon_emoji: channel.config.iconEmoji || message.icon_emoji || ':robot_face:',
      icon_url: channel.config.iconUrl,
    };

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      attempts = attempt;

      try {
        const result = await this.sendToSlack(channel.config.webhookUrl, finalMessage);

        if (result.success) {
          this.logger.log(`Slack notification delivered: ${channel.id} (attempt ${attempt})`);
          return {
            success: true,
            channelId: channel.id,
            eventId,
            statusCode: result.statusCode,
            attempts,
            deliveredAt: new Date(),
          };
        }

        lastStatusCode = result.statusCode;
        lastError = result.error;

        // Don't retry on 4xx errors
        if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500) {
          break;
        }
      } catch (error: any) {
        lastError = error.message;
        this.logger.warn(`Slack delivery failed (attempt ${attempt}): ${error.message}`);
      }

      // Exponential backoff
      if (attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
          RETRY_CONFIG.maxDelayMs,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(`Slack delivery failed after ${attempts} attempts: ${lastError}`);
    return {
      success: false,
      channelId: channel.id,
      eventId,
      statusCode: lastStatusCode,
      error: lastError,
      attempts,
    };
  }

  /**
   * Send HTTP request to Slack webhook
   */
  private async sendToSlack(
    webhookUrl: string,
    message: SlackMessage,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { success: true, statusCode: response.status };
      }

      const responseText = await response.text().catch(() => '');
      return {
        success: false,
        statusCode: response.status,
        error: `HTTP ${response.status}: ${responseText.substring(0, 200)}`,
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        return { success: false, error: `Timeout after ${this.timeoutMs}ms` };
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Record delivery attempt
   */
  private async recordDelivery(
    channelId: string,
    eventId: string,
    eventType: SlackEventType,
    result: SlackDeliveryResult,
    payload: SlackMessage,
  ): Promise<void> {
    try {
      await this.prisma.notificationDelivery.create({
        data: {
          channelId,
          eventId,
          eventType,
          success: result.success,
          statusCode: result.statusCode,
          error: result.error,
          attempts: result.attempts,
          payload: payload as any,
          deliveredAt: result.deliveredAt,
        },
      });
    } catch (error: any) {
      this.logger.warn(`Failed to record delivery: ${error.message}`);
    }
  }

  /**
   * Test a Slack channel configuration
   */
  async testChannel(channelId: string): Promise<SlackDeliveryResult> {
    const channel = await this.prisma.notificationChannel.findUnique({
      where: { id: channelId },
    });

    if (!channel || channel.type !== 'SLACK') {
      throw new Error('Slack channel not found');
    }

    const config = channel.config as unknown as SlackConfig;
    const eventId = this.generateEventId();

    const testMessage: SlackMessage = {
      text: 'ByteBot Test Notification',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: ':white_check_mark: ByteBot Connection Test',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'This is a test notification from ByteBot. If you see this message, your Slack integration is working correctly!',
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Channel: \`${channel.name}\` | Tenant: \`${channel.tenantId}\` | ${new Date().toISOString()}`,
            },
          ],
        },
      ],
    };

    const result = await this.deliverToChannel(
      { id: channelId, config },
      SlackEventType.GOAL_STARTED, // Use a dummy event type
      eventId,
      testMessage,
    );

    // Update verified status
    if (result.success) {
      await this.prisma.notificationChannel.update({
        where: { id: channelId },
        data: { verified: true },
      });
    }

    return result;
  }

  // Helper methods

  private getGoalEventStyle(eventType: SlackEventType): { emoji: string; color: string; title: string } {
    switch (eventType) {
      case SlackEventType.GOAL_STARTED:
        return { emoji: ':rocket:', color: '#2196F3', title: 'Goal Started' };
      case SlackEventType.GOAL_COMPLETED:
        return { emoji: ':white_check_mark:', color: '#4CAF50', title: 'Goal Completed' };
      case SlackEventType.GOAL_FAILED:
        return { emoji: ':x:', color: '#F44336', title: 'Goal Failed' };
      case SlackEventType.GOAL_CANCELLED:
        return { emoji: ':no_entry_sign:', color: '#9E9E9E', title: 'Goal Cancelled' };
      default:
        return { emoji: ':information_source:', color: '#607D8B', title: 'Goal Update' };
    }
  }

  private getBatchEventStyle(eventType: SlackEventType): { emoji: string; color: string; title: string } {
    switch (eventType) {
      case SlackEventType.BATCH_STARTED:
        return { emoji: ':package:', color: '#2196F3', title: 'Batch Started' };
      case SlackEventType.BATCH_PROGRESS:
        return { emoji: ':hourglass_flowing_sand:', color: '#FF9800', title: 'Batch Progress' };
      case SlackEventType.BATCH_COMPLETED:
        return { emoji: ':tada:', color: '#4CAF50', title: 'Batch Completed' };
      case SlackEventType.BATCH_FAILED:
        return { emoji: ':warning:', color: '#F44336', title: 'Batch Failed' };
      default:
        return { emoji: ':package:', color: '#607D8B', title: 'Batch Update' };
    }
  }

  private getApprovalEventStyle(eventType: SlackEventType): { emoji: string; color: string; title: string } {
    switch (eventType) {
      case SlackEventType.APPROVAL_REQUESTED:
        return { emoji: ':raised_hand:', color: '#FF9800', title: 'Approval Required' };
      case SlackEventType.APPROVAL_APPROVED:
        return { emoji: ':thumbsup:', color: '#4CAF50', title: 'Approval Granted' };
      case SlackEventType.APPROVAL_REJECTED:
        return { emoji: ':thumbsdown:', color: '#F44336', title: 'Approval Rejected' };
      case SlackEventType.APPROVAL_EXPIRED:
        return { emoji: ':hourglass:', color: '#9E9E9E', title: 'Approval Expired' };
      default:
        return { emoji: ':clipboard:', color: '#607D8B', title: 'Approval Update' };
    }
  }

  private getUserPromptEventStyle(eventType: SlackEventType): { emoji: string; color: string; title: string } {
    switch (eventType) {
      case SlackEventType.USER_PROMPT_CREATED:
        return { emoji: ':speech_balloon:', color: '#FF9800', title: 'User Input Required' };
      case SlackEventType.USER_PROMPT_RESOLVED:
        return { emoji: ':white_check_mark:', color: '#4CAF50', title: 'User Input Resolved' };
      default:
        return { emoji: ':speech_balloon:', color: '#607D8B', title: 'User Prompt Update' };
    }
  }

  private getRiskEmoji(riskLevel: string): string {
    switch (riskLevel?.toUpperCase()) {
      case 'CRITICAL':
        return ':rotating_light:';
      case 'HIGH':
        return ':warning:';
      case 'MEDIUM':
        return ':large_orange_diamond:';
      case 'LOW':
        return ':large_blue_diamond:';
      default:
        return ':grey_question:';
    }
  }

  private buildProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    const empty = 10 - filled;
    return `\`[${'█'.repeat(filled)}${'░'.repeat(empty)}]\` ${progress}%`;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  private generateEventId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString('hex');
    return `slack_${timestamp}_${random}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
