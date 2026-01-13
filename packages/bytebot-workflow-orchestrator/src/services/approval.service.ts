/**
 * Approval Service
 * v1.0.0 M5: Manages approval requests for high-risk actions
 *
 * Best Practices Applied:
 * - Clear approval context with AI reasoning preserved
 * - Workflow checkpointing for state persistence
 * - Time-bounded approvals with expiry
 * - Audit trail for all approval decisions
 *
 * References:
 * - https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/multi-agent-workflow-with-human-approval-using-agent-framework/4465927
 * - https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { HighRiskService, ActionContext, ActionClassification, ActionPreview } from './high-risk.service';

/**
 * Approval request status
 */
export enum ApprovalStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

/**
 * Approval request details
 */
export interface ApprovalRequestDetails {
  id: string;
  nodeRunId: string;
  actionHash: string;
  toolName: string;
  toolParams: Record<string, any>;
  previewData: ActionPreview;
  status: ApprovalStatus;
  expiresAt: Date;
  reason?: string;
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
  createdAt: Date;
}

/**
 * Create approval request input
 */
export interface CreateApprovalInput {
  nodeRunId: string;
  actionContext: ActionContext;
  classification: ActionClassification;
  aiReasoning?: string;
  confidenceScore?: number;
}

/**
 * Approval decision input
 */
export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reviewerId: string;
  reason?: string;
}

/**
 * Default approval expiry in minutes
 */
const DEFAULT_APPROVAL_EXPIRY_MINUTES = 60;

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly approvalExpiryMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly highRiskService: HighRiskService,
  ) {
    this.approvalExpiryMinutes = parseInt(
      this.configService.get<string>(
        'HIGH_RISK_APPROVAL_EXPIRY_MINUTES',
        String(DEFAULT_APPROVAL_EXPIRY_MINUTES),
      ),
      10,
    );

    this.logger.log(`Approval expiry: ${this.approvalExpiryMinutes} minutes`);
  }

  /**
   * Create an approval request for a high-risk action
   */
  async createApprovalRequest(input: CreateApprovalInput): Promise<ApprovalRequestDetails> {
    const { nodeRunId, actionContext, classification, aiReasoning, confidenceScore } = input;
    const { actionHash, previewData } = classification;

    // Check if approval already exists
    const existing = await this.prisma.approvalRequest.findUnique({
      where: {
        nodeRunId_actionHash: { nodeRunId, actionHash },
      },
    });

    if (existing) {
      this.logger.debug(`Approval request already exists: ${existing.id}`);
      return this.mapToDetails(existing);
    }

    // Calculate expiry time
    const expiresAt = new Date(Date.now() + this.approvalExpiryMinutes * 60 * 1000);

    // Create approval request with full context
    const approvalRequest = await this.prisma.approvalRequest.create({
      data: {
        nodeRunId,
        actionHash,
        toolName: actionContext.toolName,
        toolParams: actionContext.toolParams,
        previewData: {
          ...previewData,
          aiReasoning,
          confidenceScore,
          riskLevel: classification.riskLevel,
          riskReason: classification.reason,
          workspaceId: actionContext.workspaceId,
          tenantId: actionContext.tenantId,
          currentUrl: actionContext.currentUrl,
        },
        status: ApprovalStatus.PENDING,
        expiresAt,
      },
    });

    this.logger.log(
      `Created approval request ${approvalRequest.id} for ${actionContext.toolName} (expires: ${expiresAt.toISOString()})`,
    );

    // Update node run status to WAITING_FOR_APPROVAL
    await this.updateNodeRunStatus(nodeRunId, 'WAITING_FOR_APPROVAL');

    return this.mapToDetails(approvalRequest);
  }

  /**
   * Check if an action has been approved
   */
  async checkApprovalStatus(
    nodeRunId: string,
    actionHash: string,
  ): Promise<{ status: ApprovalStatus; approvalId?: string; reason?: string }> {
    const approval = await this.prisma.approvalRequest.findUnique({
      where: {
        nodeRunId_actionHash: { nodeRunId, actionHash },
      },
    });

    if (!approval) {
      return { status: ApprovalStatus.PENDING };
    }

    // Check for expiry
    if (approval.status === ApprovalStatus.PENDING && approval.expiresAt < new Date()) {
      await this.expireApproval(approval.id);
      return { status: ApprovalStatus.EXPIRED, approvalId: approval.id };
    }

    return {
      status: approval.status as ApprovalStatus,
      approvalId: approval.id,
      reason: approval.reason || undefined,
    };
  }

  /**
   * Get approval request by ID
   */
  async getApprovalById(approvalId: string): Promise<ApprovalRequestDetails | null> {
    const approval = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });

    if (!approval) {
      return null;
    }

    // Check for expiry
    if (approval.status === ApprovalStatus.PENDING && approval.expiresAt < new Date()) {
      await this.expireApproval(approval.id);
      const updated = await this.prisma.approvalRequest.findUnique({
        where: { id: approvalId },
      });
      return updated ? this.mapToDetails(updated) : null;
    }

    return this.mapToDetails(approval);
  }

  /**
   * Process approval decision
   */
  async processDecision(decision: ApprovalDecision): Promise<ApprovalRequestDetails> {
    const { approvalId, approved, reviewerId, reason } = decision;

    const approval = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalId },
    });

    if (!approval) {
      throw new Error(`Approval request ${approvalId} not found`);
    }

    if (approval.status !== ApprovalStatus.PENDING) {
      throw new Error(`Approval request ${approvalId} is not pending (status: ${approval.status})`);
    }

    if (approval.expiresAt < new Date()) {
      await this.expireApproval(approvalId);
      throw new Error(`Approval request ${approvalId} has expired`);
    }

    const now = new Date();

    const updated = await this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: {
        status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        ...(approved
          ? { approvedBy: reviewerId, approvedAt: now }
          : { rejectedBy: reviewerId, rejectedAt: now }),
        reason,
      },
    });

    this.logger.log(
      `Approval ${approvalId} ${approved ? 'APPROVED' : 'REJECTED'} by ${reviewerId}${reason ? `: ${reason}` : ''}`,
    );

    // Update node run status based on decision
    if (approved) {
      await this.updateNodeRunStatus(approval.nodeRunId, 'RUNNING');
    } else {
      await this.updateNodeRunStatus(approval.nodeRunId, 'FAILED');
    }

    return this.mapToDetails(updated);
  }

  /**
   * Get pending approvals for a tenant
   */
  async getPendingApprovals(tenantId: string, options?: {
    limit?: number;
    offset?: number;
  }): Promise<{ approvals: ApprovalRequestDetails[]; total: number }> {
    const { limit = 20, offset = 0 } = options || {};

    // First, expire any old approvals
    await this.expireOldApprovals();

    const where = {
      status: ApprovalStatus.PENDING,
      nodeRun: {
        node: {
          workflowRun: {
            tenantId,
          },
        },
      },
    };

    const [approvals, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);

    return {
      approvals: approvals.map((a) => this.mapToDetails(a)),
      total,
    };
  }

  /**
   * Get count of approvals by status
   * v1.0.1: Added to support frontend badge display
   */
  async getApprovalCount(
    status: string,
    tenantId?: string,
  ): Promise<number> {
    // First, expire any old approvals
    await this.expireOldApprovals();

    const where: any = { status };

    // Filter by tenant if provided
    if (tenantId) {
      where.nodeRun = {
        node: {
          workflowRun: {
            tenantId,
          },
        },
      };
    }

    return this.prisma.approvalRequest.count({ where });
  }

  /**
   * Get approvals for a specific node run
   */
  async getApprovalsForNodeRun(nodeRunId: string): Promise<ApprovalRequestDetails[]> {
    const approvals = await this.prisma.approvalRequest.findMany({
      where: { nodeRunId },
      orderBy: { createdAt: 'desc' },
    });

    return approvals.map((a) => this.mapToDetails(a));
  }

  /**
   * Expire a single approval
   */
  private async expireApproval(approvalId: string): Promise<void> {
    await this.prisma.approvalRequest.update({
      where: { id: approvalId },
      data: { status: ApprovalStatus.EXPIRED },
    });

    this.logger.log(`Approval ${approvalId} expired`);
  }

  /**
   * Expire all old pending approvals
   */
  async expireOldApprovals(): Promise<number> {
    const result = await this.prisma.approvalRequest.updateMany({
      where: {
        status: ApprovalStatus.PENDING,
        expiresAt: { lt: new Date() },
      },
      data: { status: ApprovalStatus.EXPIRED },
    });

    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} old approval requests`);
    }

    return result.count;
  }

  /**
   * Update node run status
   */
  private async updateNodeRunStatus(nodeRunId: string, status: string): Promise<void> {
    try {
      await this.prisma.workflowNodeRun.update({
        where: { id: nodeRunId },
        data: { status },
      });
    } catch (error: any) {
      this.logger.warn(`Failed to update node run ${nodeRunId} status: ${error.message}`);
    }
  }

  /**
   * Map Prisma model to details interface
   */
  private mapToDetails(approval: any): ApprovalRequestDetails {
    return {
      id: approval.id,
      nodeRunId: approval.nodeRunId,
      actionHash: approval.actionHash,
      toolName: approval.toolName,
      toolParams: approval.toolParams,
      previewData: approval.previewData as ActionPreview,
      status: approval.status as ApprovalStatus,
      expiresAt: approval.expiresAt,
      reason: approval.reason || undefined,
      approvedBy: approval.approvedBy || undefined,
      approvedAt: approval.approvedAt || undefined,
      rejectedBy: approval.rejectedBy || undefined,
      rejectedAt: approval.rejectedAt || undefined,
      createdAt: approval.createdAt,
    };
  }
}
