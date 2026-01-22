/**
 * Microsoft Teams Notification Service
 * Phase 8: External Integrations
 *
 * Sends notifications to Microsoft Teams via Incoming Webhooks.
 * Uses Adaptive Cards for rich message formatting.
 *
 * Features:
 * - Rich Adaptive Card message formatting
 * - Goal run notifications (started, completed, failed)
 * - Batch progress notifications
 * - Approval request notifications with action buttons
 * - Configurable per-channel settings
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import * as crypto from 'crypto';

// Teams configuration interface
export interface TeamsConfig {
  webhookUrl: string;
}

// Adaptive Card interfaces
interface AdaptiveCardElement {
  type: string;
  text?: string;
  size?: string;
  weight?: string;
  color?: string;
  wrap?: boolean;
  spacing?: string;
  separator?: boolean;
  columns?: AdaptiveCardElement[];
  width?: string;
  items?: AdaptiveCardElement[];
  facts?: Array<{ title: string; value: string }>;
  style?: string;
  actions?: AdaptiveCardAction[];
  url?: string;
  altText?: string;
  horizontalAlignment?: string;
  isSubtle?: boolean;
}

interface AdaptiveCardAction {
  type: string;
  title: string;
  url?: string;
  style?: string;
}

interface AdaptiveCard {
  type: 'AdaptiveCard';
  version: string;
  body: AdaptiveCardElement[];
  actions?: AdaptiveCardAction[];
  $schema: string;
  msteams?: {
    width?: string;
  };
}

interface TeamsMessage {
  type: 'message';
  attachments: Array<{
    contentType: string;
    contentUrl: string | null;
    content: AdaptiveCard;
  }>;
}

// Event types (reuse from Slack)
export enum TeamsEventType {
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
  USER_PROMPT_CANCELLED = 'user_prompt.cancelled',
}

// Event data interfaces (same as Slack)
export interface GoalEventData {
  goalRunId: string;
  tenantId: string;
  goal: string;
  status: string;
  phase?: string;
  templateName?: string;
  duration?: number;
  error?: string;
  stepsCompleted?: number;
  totalSteps?: number;
  links?: { goalRun?: string };
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
  links?: { batch?: string };
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
  links?: { approval?: string };
}

export interface UserPromptEventData {
  promptId: string;
  tenantId: string;
  goalRunId: string;
  checklistItemId: string | null;
  kind: string;
  stepDescription?: string | null;
  links?: { goalRun?: string; prompt?: string; desktopTakeover?: string | null };
}

export interface TeamsDeliveryResult {
  success: boolean;
  channelId: string;
  eventId: string;
  statusCode?: number;
  error?: string;
  attempts: number;
  deliveredAt?: Date;
}

const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

@Injectable()
export class TeamsNotificationService {
  private readonly logger = new Logger(TeamsNotificationService.name);
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
      this.configService.get<string>('TEAMS_TIMEOUT_MS', '10000'),
      10,
    );
    this.logger.log('TeamsNotificationService initialized');
  }

  /**
   * Send a goal event notification
   */
  async sendGoalNotification(
    eventType: TeamsEventType,
    data: GoalEventData,
  ): Promise<TeamsDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Teams channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const card = this.buildGoalCard(eventType, data);
    return this.deliverToChannels(channels, eventType, card);
  }

  /**
   * Send a batch event notification
   */
  async sendBatchNotification(
    eventType: TeamsEventType,
    data: BatchEventData,
  ): Promise<TeamsDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Teams channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const card = this.buildBatchCard(eventType, data);
    return this.deliverToChannels(channels, eventType, card);
  }

  /**
   * Send an approval event notification
   */
  async sendApprovalNotification(
    eventType: TeamsEventType,
    data: ApprovalEventData,
  ): Promise<TeamsDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Teams channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const card = this.buildApprovalCard(eventType, data);
    return this.deliverToChannels(channels, eventType, card);
  }

  /**
   * Send a user prompt notification (durable WAIT surface)
   */
  async sendUserPromptNotification(
    eventType: TeamsEventType,
    data: UserPromptEventData,
    options?: { eventId?: string },
  ): Promise<TeamsDeliveryResult[]> {
    const channels = await this.getActiveChannels(data.tenantId, eventType);

    if (channels.length === 0) {
      this.logger.debug(`No Teams channels for ${eventType} in tenant ${data.tenantId}`);
      return [];
    }

    const card = this.buildUserPromptCard(eventType, data);
    return this.deliverToChannels(channels, eventType, card, options);
  }

  private buildUserPromptCard(eventType: TeamsEventType, data: UserPromptEventData): AdaptiveCard {
    const { color, title, icon } = this.getUserPromptEventStyle(eventType);
    const goalRunLink = data.links?.goalRun || `${this.baseUrl}/goals/${data.goalRunId}`;
    const promptLink = data.links?.prompt || `${this.baseUrl}/prompts/${data.promptId}`;
    const desktopTakeoverLink = data.links?.desktopTakeover || null;

    const body: AdaptiveCardElement[] = [
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            items: [{ type: 'TextBlock', text: icon, size: 'Large' }],
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: title,
                size: 'Large',
                weight: 'Bolder',
                color,
              },
            ],
          },
        ],
      },
      {
        type: 'TextBlock',
        text: `Step: ${data.stepDescription || '(no description)'}`,
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Prompt Kind', value: data.kind },
          { title: 'Goal Run', value: data.goalRunId },
          { title: 'Prompt ID', value: data.promptId },
        ],
      },
    ];

    const actions: AdaptiveCardAction[] = [];
    if (promptLink) {
      actions.push({ type: 'Action.OpenUrl', title: 'Open Prompt', url: promptLink });
    }
    if (goalRunLink) {
      actions.push({ type: 'Action.OpenUrl', title: 'Open Goal Run', url: goalRunLink });
    }
    if (desktopTakeoverLink) {
      actions.push({ type: 'Action.OpenUrl', title: 'Take Over Desktop', url: desktopTakeoverLink });
    }

    return {
      type: 'AdaptiveCard',
      version: '1.4',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      body,
      actions: actions.length > 0 ? actions : undefined,
      msteams: { width: 'Full' },
    };
  }
  /**
   * Build Adaptive Card for goal events
   */
  private buildGoalCard(eventType: TeamsEventType, data: GoalEventData): AdaptiveCard {
    const { color, title, icon } = this.getGoalEventStyle(eventType);

    const body: AdaptiveCardElement[] = [
      // Header with icon and title
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            items: [
              {
                type: 'TextBlock',
                text: icon,
                size: 'Large',
              },
            ],
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: title,
                size: 'Large',
                weight: 'Bolder',
                color,
              },
            ],
          },
        ],
      },
      // Goal text
      {
        type: 'TextBlock',
        text: this.truncateText(data.goal, 200),
        wrap: true,
        spacing: 'Medium',
      },
      // Facts
      {
        type: 'FactSet',
        facts: [
          { title: 'Status', value: data.status },
          ...(data.phase ? [{ title: 'Phase', value: data.phase }] : []),
          ...(data.templateName ? [{ title: 'Template', value: data.templateName }] : []),
          ...(data.duration ? [{ title: 'Duration', value: this.formatDuration(data.duration) }] : []),
          ...(data.stepsCompleted !== undefined
            ? [{ title: 'Steps', value: `${data.stepsCompleted}/${data.totalSteps || '?'}` }]
            : []),
        ],
        spacing: 'Medium',
      },
    ];

    // Add error for failed goals
    if (data.error && eventType === TeamsEventType.GOAL_FAILED) {
      body.push({
        type: 'TextBlock',
        text: `**Error:** ${this.truncateText(data.error, 300)}`,
        wrap: true,
        color: 'Attention',
        spacing: 'Medium',
      });
    }

    // Footer with ID and timestamp
    body.push({
      type: 'TextBlock',
      text: `Goal Run ID: ${data.goalRunId} | ${new Date().toISOString()}`,
      size: 'Small',
      isSubtle: true,
      spacing: 'Medium',
    });

    const actions: AdaptiveCardAction[] = [];
    if (data.links?.goalRun) {
      actions.push({
        type: 'Action.OpenUrl',
        title: 'View Goal Run',
        url: data.links.goalRun,
      });
    }

    return {
      type: 'AdaptiveCard',
      version: '1.4',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      msteams: { width: 'Full' },
      body,
      actions: actions.length > 0 ? actions : undefined,
    };
  }

  /**
   * Build Adaptive Card for batch events
   */
  private buildBatchCard(eventType: TeamsEventType, data: BatchEventData): AdaptiveCard {
    const { color, title, icon } = this.getBatchEventStyle(eventType);

    const progressPercent = Math.min(100, Math.max(0, data.progress));

    const body: AdaptiveCardElement[] = [
      // Header
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            items: [{ type: 'TextBlock', text: icon, size: 'Large' }],
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: title,
                size: 'Large',
                weight: 'Bolder',
                color,
              },
            ],
          },
        ],
      },
      // Batch name
      {
        type: 'TextBlock',
        text: `**Batch:** ${data.name}`,
        wrap: true,
        spacing: 'Medium',
      },
      // Progress bar simulation using columns
      {
        type: 'ColumnSet',
        spacing: 'Medium',
        columns: [
          {
            type: 'Column',
            width: `${progressPercent}`,
            items: [
              {
                type: 'Container',
                style: 'emphasis',
                items: [{ type: 'TextBlock', text: ' ', size: 'Small' }],
              },
            ],
          },
          {
            type: 'Column',
            width: `${100 - progressPercent}`,
            items: [{ type: 'TextBlock', text: ' ', size: 'Small' }],
          },
        ],
      },
      // Facts
      {
        type: 'FactSet',
        facts: [
          { title: 'Status', value: data.status },
          { title: 'Progress', value: `${data.progress}%` },
          { title: 'Completed', value: `${data.completedGoals}/${data.totalGoals}` },
          { title: 'Failed', value: data.failedGoals.toString() },
        ],
        spacing: 'Medium',
      },
      // Footer
      {
        type: 'TextBlock',
        text: `Batch ID: ${data.batchId} | ${new Date().toISOString()}`,
        size: 'Small',
        isSubtle: true,
        spacing: 'Medium',
      },
    ];

    const actions: AdaptiveCardAction[] = [];
    if (data.links?.batch) {
      actions.push({
        type: 'Action.OpenUrl',
        title: 'View Batch',
        url: data.links.batch,
      });
    }

    return {
      type: 'AdaptiveCard',
      version: '1.4',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      msteams: { width: 'Full' },
      body,
      actions: actions.length > 0 ? actions : undefined,
    };
  }

  /**
   * Build Adaptive Card for approval events
   */
  private buildApprovalCard(eventType: TeamsEventType, data: ApprovalEventData): AdaptiveCard {
    const { color, title, icon } = this.getApprovalEventStyle(eventType);

    const body: AdaptiveCardElement[] = [
      // Header
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'auto',
            items: [{ type: 'TextBlock', text: icon, size: 'Large' }],
          },
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: title,
                size: 'Large',
                weight: 'Bolder',
                color,
              },
            ],
          },
        ],
      },
      // Summary
      {
        type: 'TextBlock',
        text: `**Action:** ${data.summary}`,
        wrap: true,
        spacing: 'Medium',
      },
      // Facts
      {
        type: 'FactSet',
        facts: [
          { title: 'Tool', value: data.toolName },
          { title: 'Risk Level', value: `${this.getRiskIcon(data.riskLevel)} ${data.riskLevel}` },
          ...(data.decision
            ? [
                { title: 'Decision', value: data.decision.status },
                ...(data.decision.reviewerId
                  ? [{ title: 'Reviewer', value: data.decision.reviewerId }]
                  : []),
                ...(data.decision.reason
                  ? [{ title: 'Reason', value: data.decision.reason }]
                  : []),
              ]
            : []),
        ],
        spacing: 'Medium',
      },
      // Footer
      {
        type: 'TextBlock',
        text: `Approval ID: ${data.approvalId} | ${new Date().toISOString()}`,
        size: 'Small',
        isSubtle: true,
        spacing: 'Medium',
      },
    ];

    const actions: AdaptiveCardAction[] = [];
    if (data.links?.approval) {
      actions.push({
        type: 'Action.OpenUrl',
        title: eventType === TeamsEventType.APPROVAL_REQUESTED ? 'Review & Approve' : 'View Details',
        url: data.links.approval,
        style: eventType === TeamsEventType.APPROVAL_REQUESTED ? 'destructive' : 'default',
      });
    }

    return {
      type: 'AdaptiveCard',
      version: '1.4',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      msteams: { width: 'Full' },
      body,
      actions: actions.length > 0 ? actions : undefined,
    };
  }

  /**
   * Get active Teams channels
   */
  private async getActiveChannels(
    tenantId: string,
    eventType: TeamsEventType,
  ): Promise<Array<{ id: string; config: TeamsConfig }>> {
    try {
      const channels = await this.prisma.notificationChannel.findMany({
        where: {
          tenantId,
          type: 'TEAMS',
          enabled: true,
          events: { has: eventType },
        },
      });

      return channels.map((c) => ({
        id: c.id,
        config: c.config as unknown as TeamsConfig,
      }));
    } catch (error: any) {
      if (error.code === 'P2021' || error.message?.includes('does not exist')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Deliver to multiple channels
   */
  private async deliverToChannels(
    channels: Array<{ id: string; config: TeamsConfig }>,
    eventType: TeamsEventType,
    card: AdaptiveCard,
    options?: { eventId?: string },
  ): Promise<TeamsDeliveryResult[]> {
    const eventId = options?.eventId ?? this.generateEventId();
    const results: TeamsDeliveryResult[] = [];

    for (const channel of channels) {
      const result = await this.deliverToChannel(channel, eventType, eventId, card);
      results.push(result);
      await this.recordDelivery(channel.id, eventId, eventType, result, card);
    }

    return results;
  }

  /**
   * Deliver to single channel with retry
   */
  private async deliverToChannel(
    channel: { id: string; config: TeamsConfig },
    eventType: TeamsEventType,
    eventId: string,
    card: AdaptiveCard,
  ): Promise<TeamsDeliveryResult> {
    let lastError: string | undefined;
    let lastStatusCode: number | undefined;
    let attempts = 0;

    const message: TeamsMessage = {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: card,
        },
      ],
    };

    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      attempts = attempt;

      try {
        const result = await this.sendToTeams(channel.config.webhookUrl, message);

        if (result.success) {
          this.logger.log(`Teams notification delivered: ${channel.id} (attempt ${attempt})`);
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

        if (result.statusCode && result.statusCode >= 400 && result.statusCode < 500) {
          break;
        }
      } catch (error: any) {
        lastError = error.message;
        this.logger.warn(`Teams delivery failed (attempt ${attempt}): ${error.message}`);
      }

      if (attempt < RETRY_CONFIG.maxAttempts) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1),
          RETRY_CONFIG.maxDelayMs,
        );
        await this.sleep(delay);
      }
    }

    this.logger.error(`Teams delivery failed after ${attempts} attempts: ${lastError}`);
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
   * Send to Teams webhook
   */
  private async sendToTeams(
    webhookUrl: string,
    message: TeamsMessage,
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
   * Record delivery
   */
  private async recordDelivery(
    channelId: string,
    eventId: string,
    eventType: TeamsEventType,
    result: TeamsDeliveryResult,
    payload: AdaptiveCard,
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
   * Test channel
   */
  async testChannel(channelId: string): Promise<TeamsDeliveryResult> {
    const channel = await this.prisma.notificationChannel.findUnique({
      where: { id: channelId },
    });

    if (!channel || channel.type !== 'TEAMS') {
      throw new Error('Teams channel not found');
    }

    const config = channel.config as unknown as TeamsConfig;
    const eventId = this.generateEventId();

    const testCard: AdaptiveCard = {
      type: 'AdaptiveCard',
      version: '1.4',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      body: [
        {
          type: 'TextBlock',
          text: '✅ ByteBot Connection Test',
          size: 'Large',
          weight: 'Bolder',
          color: 'Good',
        },
        {
          type: 'TextBlock',
          text: 'This is a test notification from ByteBot. If you see this message, your Teams integration is working correctly!',
          wrap: true,
          spacing: 'Medium',
        },
        {
          type: 'TextBlock',
          text: `Channel: ${channel.name} | Tenant: ${channel.tenantId} | ${new Date().toISOString()}`,
          size: 'Small',
          isSubtle: true,
          spacing: 'Medium',
        },
      ],
    };

    const result = await this.deliverToChannel(
      { id: channelId, config },
      TeamsEventType.GOAL_STARTED,
      eventId,
      testCard,
    );

    if (result.success) {
      await this.prisma.notificationChannel.update({
        where: { id: channelId },
        data: { verified: true },
      });
    }

    return result;
  }

  // Helper methods

  private getGoalEventStyle(eventType: TeamsEventType): { color: string; title: string; icon: string } {
    switch (eventType) {
      case TeamsEventType.GOAL_STARTED:
        return { color: 'Accent', title: 'Goal Started', icon: '🚀' };
      case TeamsEventType.GOAL_COMPLETED:
        return { color: 'Good', title: 'Goal Completed', icon: '✅' };
      case TeamsEventType.GOAL_FAILED:
        return { color: 'Attention', title: 'Goal Failed', icon: '❌' };
      case TeamsEventType.GOAL_CANCELLED:
        return { color: 'Default', title: 'Goal Cancelled', icon: '🚫' };
      default:
        return { color: 'Default', title: 'Goal Update', icon: 'ℹ️' };
    }
  }

  private getBatchEventStyle(eventType: TeamsEventType): { color: string; title: string; icon: string } {
    switch (eventType) {
      case TeamsEventType.BATCH_STARTED:
        return { color: 'Accent', title: 'Batch Started', icon: '📦' };
      case TeamsEventType.BATCH_PROGRESS:
        return { color: 'Warning', title: 'Batch Progress', icon: '⏳' };
      case TeamsEventType.BATCH_COMPLETED:
        return { color: 'Good', title: 'Batch Completed', icon: '🎉' };
      case TeamsEventType.BATCH_FAILED:
        return { color: 'Attention', title: 'Batch Failed', icon: '⚠️' };
      default:
        return { color: 'Default', title: 'Batch Update', icon: '📦' };
    }
  }

  private getApprovalEventStyle(eventType: TeamsEventType): { color: string; title: string; icon: string } {
    switch (eventType) {
      case TeamsEventType.APPROVAL_REQUESTED:
        return { color: 'Warning', title: 'Approval Required', icon: '✋' };
      case TeamsEventType.APPROVAL_APPROVED:
        return { color: 'Good', title: 'Approval Granted', icon: '👍' };
      case TeamsEventType.APPROVAL_REJECTED:
        return { color: 'Attention', title: 'Approval Rejected', icon: '👎' };
      case TeamsEventType.APPROVAL_EXPIRED:
        return { color: 'Default', title: 'Approval Expired', icon: '⏰' };
      default:
        return { color: 'Default', title: 'Approval Update', icon: '📋' };
    }
  }

  private getUserPromptEventStyle(eventType: TeamsEventType): { color: string; title: string; icon: string } {
    switch (eventType) {
      case TeamsEventType.USER_PROMPT_CREATED:
        return { color: 'Warning', title: 'User Input Required', icon: '💬' };
      case TeamsEventType.USER_PROMPT_RESOLVED:
        return { color: 'Good', title: 'User Input Resolved', icon: '✅' };
      case TeamsEventType.USER_PROMPT_CANCELLED:
        return { color: 'Default', title: 'User Prompt Cancelled', icon: '⛔' };
      default:
        return { color: 'Default', title: 'User Prompt Update', icon: '💬' };
    }
  }

  private getRiskIcon(riskLevel: string): string {
    switch (riskLevel?.toUpperCase()) {
      case 'CRITICAL': return '🚨';
      case 'HIGH': return '⚠️';
      case 'MEDIUM': return '🔶';
      case 'LOW': return '🔷';
      default: return '❓';
    }
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
    return `teams_${timestamp}_${random}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
