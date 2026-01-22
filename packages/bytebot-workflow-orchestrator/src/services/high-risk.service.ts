/**
 * High-Risk Action Service
 * v1.0.0 M5: Classifies actions and generates deterministic fingerprints
 *
 * Best Practices Applied:
 * - Risk-based gating (categorize by risk level)
 * - Deterministic fingerprinting for idempotency
 * - Context preservation for approval decisions
 *
 * References:
 * - https://blog.algomaster.io/p/idempotency-in-distributed-systems
 * - https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices
 */

import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Risk levels for actions
 */
export enum RiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Ordinal mapping for risk level comparison
 * Used because string comparison doesn't work correctly
 * (e.g., 'HIGH' < 'MEDIUM' in ASCII)
 */
const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  [RiskLevel.LOW]: 0,
  [RiskLevel.MEDIUM]: 1,
  [RiskLevel.HIGH]: 2,
  [RiskLevel.CRITICAL]: 3,
};

/**
 * Compare risk levels using ordinal values
 * @returns true if current >= threshold
 */
export function isRiskLevelAtLeast(current: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_LEVEL_ORDER[current] >= RISK_LEVEL_ORDER[threshold];
}

/**
 * Get the numeric order value for a risk level
 * Useful for sorting or custom comparisons
 */
export function getRiskLevelOrder(level: RiskLevel): number {
  return RISK_LEVEL_ORDER[level];
}

/**
 * Action context for risk assessment
 */
export interface ActionContext {
  toolName: string;
  toolParams: Record<string, any>;
  currentUrl?: string;
  nodeRunId: string;
  workspaceId: string;
  tenantId: string;
}

/**
 * High-risk action classification result
 */
export interface ActionClassification {
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  reason: string;
  actionHash: string;
  previewData: ActionPreview;
}

/**
 * Preview data for approval UI
 */
export interface ActionPreview {
  toolName: string;
  category: string;
  summary: string;
  recipient?: string;
  subject?: string;
  amount?: string;
  bodyPreview?: string;
  context: Record<string, any>;
}

/**
 * High-risk gateway tools requiring approval
 */
const HIGH_RISK_GATEWAY_TOOLS: Record<string, {
  riskLevel: RiskLevel;
  reason: string;
  extractPreview: (params: Record<string, any>) => Partial<ActionPreview>;
}> = {
  'communications_send_email': {
    riskLevel: RiskLevel.HIGH,
    reason: 'Sends email to external recipient - cannot be undone',
    extractPreview: (params) => ({
      category: 'Communications',
      summary: `Send email to ${params.to || params.recipient || 'unknown'}`,
      recipient: params.to || params.recipient,
      subject: params.subject,
      bodyPreview: truncate(params.body || params.message, 200),
    }),
  },
  'communications_send_sms': {
    riskLevel: RiskLevel.HIGH,
    reason: 'Sends SMS to external number - cannot be undone',
    extractPreview: (params) => ({
      category: 'Communications',
      summary: `Send SMS to ${params.to || params.phone_number || 'unknown'}`,
      recipient: params.to || params.phone_number,
      bodyPreview: truncate(params.message || params.body, 160),
    }),
  },
  'integration_webhook': {
    riskLevel: RiskLevel.MEDIUM,
    reason: 'Sends data to external webhook endpoint',
    extractPreview: (params) => ({
      category: 'Integration',
      summary: `Send webhook to ${new URL(params.url || '').hostname || 'unknown'}`,
      context: { url: params.url },
    }),
  },
  'integration_api_call': {
    riskLevel: RiskLevel.MEDIUM,
    reason: 'Makes external API call with potential side effects',
    extractPreview: (params) => ({
      category: 'Integration',
      summary: `API call to ${params.endpoint || params.url || 'unknown'}`,
      context: { method: params.method, endpoint: params.endpoint },
    }),
  },
  'calendar_delete_event': {
    riskLevel: RiskLevel.MEDIUM,
    reason: 'Deletes calendar event - may affect scheduled meetings',
    extractPreview: (params) => ({
      category: 'Calendar',
      summary: `Delete calendar event: ${params.event_id || 'unknown'}`,
    }),
  },
  'notes_delete': {
    riskLevel: RiskLevel.MEDIUM,
    reason: 'Deletes notes - data loss potential',
    extractPreview: (params) => ({
      category: 'Notes',
      summary: `Delete note: ${params.note_id || 'unknown'}`,
    }),
  },
  'rag_ingest': {
    riskLevel: RiskLevel.MEDIUM,
    reason: 'Ingests documents into knowledge base',
    extractPreview: (params) => ({
      category: 'RAG',
      summary: `Ingest ${params.documents?.length || 1} document(s)`,
    }),
  },
};

/**
 * High-risk URL patterns for desktop actions
 */
const HIGH_RISK_URL_PATTERNS = [
  { pattern: /checkout\./i, reason: 'Checkout page - payment action' },
  { pattern: /payment\./i, reason: 'Payment page - financial action' },
  { pattern: /pay\./i, reason: 'Payment page - financial action' },
  { pattern: /buy\./i, reason: 'Purchase page - financial action' },
  { pattern: /order\./i, reason: 'Order page - purchase action' },
  { pattern: /cart.*confirm/i, reason: 'Cart confirmation - purchase action' },
  { pattern: /billing\./i, reason: 'Billing page - financial action' },
  { pattern: /subscribe/i, reason: 'Subscription page - recurring payment' },
  { pattern: /bank/i, reason: 'Banking page - financial action' },
  { pattern: /transfer/i, reason: 'Transfer page - financial action' },
];

/**
 * High-risk desktop action types
 */
const HIGH_RISK_DESKTOP_ACTIONS = [
  'submit_form',
  'click_buy',
  'click_purchase',
  'click_confirm',
  'click_pay',
  'click_subscribe',
  'click_delete',
  'click_remove',
  'click_cancel',
];

/**
 * Helper to truncate text for preview
 */
function truncate(text: string | undefined, maxLength: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Canonicalize object for deterministic hashing
 * Sorts keys and removes undefined values
 */
function canonicalize(obj: Record<string, any>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, any> = {};

  for (const key of sortedKeys) {
    const value = obj[key];
    if (value !== undefined && value !== null) {
      if (typeof value === 'object' && !Array.isArray(value)) {
        sortedObj[key] = JSON.parse(canonicalize(value));
      } else {
        sortedObj[key] = value;
      }
    }
  }

  return JSON.stringify(sortedObj);
}

@Injectable()
export class HighRiskService {
  private readonly logger = new Logger(HighRiskService.name);

  /**
   * Classify an action and determine if approval is required
   */
  classifyAction(context: ActionContext): ActionClassification {
    const { toolName, toolParams, currentUrl } = context;

    // Check if it's a known high-risk gateway tool
    const gatewayRisk = HIGH_RISK_GATEWAY_TOOLS[toolName];
    if (gatewayRisk) {
      const previewExtractor = gatewayRisk.extractPreview;
      const previewData: ActionPreview = {
        toolName,
        category: 'Gateway',
        summary: '',
        context: {},
        ...previewExtractor(toolParams),
      };

      return {
        riskLevel: gatewayRisk.riskLevel,
        requiresApproval: isRiskLevelAtLeast(gatewayRisk.riskLevel, RiskLevel.MEDIUM),
        reason: gatewayRisk.reason,
        actionHash: this.generateActionHash(context),
        previewData,
      };
    }

    // Check desktop actions with URL context
    if (toolName.startsWith('desktop_') || toolName === 'computer') {
      const desktopRisk = this.classifyDesktopAction(toolName, toolParams, currentUrl);
      if (desktopRisk.requiresApproval) {
        return {
          ...desktopRisk,
          actionHash: this.generateActionHash(context),
        };
      }
    }

    // Default: low risk, no approval required
    return {
      riskLevel: RiskLevel.LOW,
      requiresApproval: false,
      reason: 'Standard operation',
      actionHash: this.generateActionHash(context),
      previewData: {
        toolName,
        category: this.getToolCategory(toolName),
        summary: `Execute ${toolName}`,
        context: toolParams,
      },
    };
  }

  /**
   * Classify desktop action based on action type and URL context
   */
  private classifyDesktopAction(
    toolName: string,
    params: Record<string, any>,
    currentUrl?: string,
  ): Omit<ActionClassification, 'actionHash'> {
    // Check if action type is high-risk
    const actionType = params.action || params.type || '';
    const isHighRiskAction = HIGH_RISK_DESKTOP_ACTIONS.some(
      (risky) => actionType.toLowerCase().includes(risky.replace('click_', '').replace('_', '')),
    );

    // Check if URL is high-risk
    let urlRiskReason: string | null = null;
    if (currentUrl) {
      for (const { pattern, reason } of HIGH_RISK_URL_PATTERNS) {
        if (pattern.test(currentUrl)) {
          urlRiskReason = reason;
          break;
        }
      }
    }

    // Determine overall risk
    if (isHighRiskAction && urlRiskReason) {
      return {
        riskLevel: RiskLevel.CRITICAL,
        requiresApproval: true,
        reason: `${urlRiskReason} with ${actionType} action`,
        previewData: {
          toolName,
          category: 'Desktop',
          summary: `${actionType} on ${new URL(currentUrl!).hostname}`,
          context: { url: currentUrl, action: actionType },
        },
      };
    }

    if (urlRiskReason) {
      return {
        riskLevel: RiskLevel.HIGH,
        requiresApproval: true,
        reason: urlRiskReason,
        previewData: {
          toolName,
          category: 'Desktop',
          summary: `Desktop action on ${new URL(currentUrl!).hostname}`,
          context: { url: currentUrl, action: actionType },
        },
      };
    }

    if (isHighRiskAction) {
      return {
        riskLevel: RiskLevel.MEDIUM,
        requiresApproval: true,
        reason: `High-risk action type: ${actionType}`,
        previewData: {
          toolName,
          category: 'Desktop',
          summary: `${actionType} action`,
          context: { action: actionType },
        },
      };
    }

    return {
      riskLevel: RiskLevel.LOW,
      requiresApproval: false,
      reason: 'Standard desktop operation',
      previewData: {
        toolName,
        category: 'Desktop',
        summary: `Desktop ${actionType || 'action'}`,
        context: params,
      },
    };
  }

  /**
   * Generate deterministic hash for an action
   * Used for idempotency and approval tracking
   *
   * Best practice: Use canonical representation for deterministic hashing
   */
  generateActionHash(context: ActionContext): string {
    const { toolName, toolParams, currentUrl, nodeRunId, workspaceId } = context;

    // Extract key identifying fields based on tool type
    const keyFields: Record<string, any> = {
      tool: toolName,
      nodeRunId,
      workspaceId,
    };

    // Add tool-specific identifying fields
    if (toolName === 'communications_send_email') {
      keyFields.recipient = toolParams.to || toolParams.recipient;
      keyFields.subject = toolParams.subject;
    } else if (toolName === 'communications_send_sms') {
      keyFields.recipient = toolParams.to || toolParams.phone_number;
      keyFields.message = toolParams.message?.substring(0, 50); // First 50 chars
    } else if (currentUrl) {
      // For desktop actions, include URL domain
      try {
        keyFields.domain = new URL(currentUrl).hostname;
      } catch {
        keyFields.domain = currentUrl;
      }
    }

    // Add critical params that identify the action
    if (toolParams.amount) keyFields.amount = toolParams.amount;
    if (toolParams.event_id) keyFields.event_id = toolParams.event_id;
    if (toolParams.note_id) keyFields.note_id = toolParams.note_id;

    // Generate deterministic hash
    const canonicalString = canonicalize(keyFields);
    const hash = crypto
      .createHash('sha256')
      .update(canonicalString)
      .digest('hex')
      .substring(0, 16);

    this.logger.debug(`Generated action hash: ${hash} for ${toolName}`);
    return hash;
  }

  /**
   * Get tool category for display
   */
  private getToolCategory(toolName: string): string {
    const [prefix] = toolName.split('_');
    const categories: Record<string, string> = {
      communications: 'Communications',
      search: 'Search',
      weather: 'Weather',
      calendar: 'Calendar',
      notes: 'Notes',
      document: 'Document',
      data: 'Data',
      file: 'File',
      integration: 'Integration',
      rag: 'RAG',
      desktop: 'Desktop',
      computer: 'Desktop',
    };
    return categories[prefix] || 'Other';
  }

  /**
   * Check if a tool requires approval by default (without context)
   */
  isHighRiskTool(toolName: string): boolean {
    return toolName in HIGH_RISK_GATEWAY_TOOLS;
  }

  /**
   * Get list of high-risk tool names
   */
  getHighRiskToolNames(): string[] {
    return Object.keys(HIGH_RISK_GATEWAY_TOOLS);
  }
}
