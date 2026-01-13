/**
 * Approval Controller
 * v1.0.1 M5: API endpoints for managing high-risk action approvals
 *
 * Endpoints:
 * - GET  /api/v1/approvals           List pending approvals
 * - GET  /api/v1/approvals/count     Get count of approvals by status
 * - GET  /api/v1/approvals/:id       Get approval details
 * - POST /api/v1/approvals/:id/approve  Approve action
 * - POST /api/v1/approvals/:id/reject   Reject action
 * - GET  /api/v1/approvals/stats     Get approval statistics
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpException,
  HttpStatus,
  Logger,
  Headers,
} from '@nestjs/common';
import { ApprovalService, ApprovalStatus } from '../services/approval.service';
import { IdempotencyService } from '../services/idempotency.service';
import { HighRiskService } from '../services/high-risk.service';

/**
 * DTOs for approval endpoints
 */
interface ApproveActionDto {
  reason?: string;
}

interface RejectActionDto {
  reason: string;
}

interface RequestApprovalDto {
  nodeRunId: string;
  workspaceId: string;
  tenantId: string;
  toolName: string;
  toolParams: Record<string, any>;
  currentUrl?: string;
  aiReasoning?: string;
}

interface ListApprovalsQuery {
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  limit?: string;
  offset?: string;
}

@Controller('approvals')
export class ApprovalController {
  private readonly logger = new Logger(ApprovalController.name);

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly idempotencyService: IdempotencyService,
    private readonly highRiskService: HighRiskService,
  ) {}

  /**
   * POST /api/v1/approvals/request
   * Request approval for a high-risk action (called by agent)
   */
  @Post('request')
  async requestApproval(@Body() body: RequestApprovalDto) {
    if (!body.nodeRunId || !body.toolName) {
      throw new HttpException(
        'nodeRunId and toolName are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Classify the action
    const classification = this.highRiskService.classifyAction({
      toolName: body.toolName,
      toolParams: body.toolParams,
      currentUrl: body.currentUrl,
      nodeRunId: body.nodeRunId,
      workspaceId: body.workspaceId,
      tenantId: body.tenantId,
    });

    // Check if approval is actually required
    if (!classification.requiresApproval) {
      return {
        success: true,
        requiresApproval: false,
        message: 'Action does not require approval',
        riskLevel: classification.riskLevel,
      };
    }

    try {
      // Create approval request
      const approval = await this.approvalService.createApprovalRequest({
        nodeRunId: body.nodeRunId,
        actionContext: {
          toolName: body.toolName,
          toolParams: body.toolParams,
          currentUrl: body.currentUrl,
          nodeRunId: body.nodeRunId,
          workspaceId: body.workspaceId,
          tenantId: body.tenantId,
        },
        classification,
        aiReasoning: body.aiReasoning,
      });

      this.logger.log(
        `Created approval request ${approval.id} for ${body.toolName} (risk: ${classification.riskLevel})`,
      );

      return {
        success: true,
        requiresApproval: true,
        approval: this.formatApproval(approval),
        message: 'Action requires human approval before execution',
      };
    } catch (error: any) {
      this.logger.error(`Failed to create approval request: ${error.message}`);
      throw new HttpException(
        `Failed to create approval request: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/approvals
   * List pending approvals for a tenant
   */
  @Get()
  async listApprovals(
    @Query() query: ListApprovalsQuery,
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new HttpException('X-Tenant-Id header required', HttpStatus.BAD_REQUEST);
    }

    const limit = parseInt(query.limit || '20', 10);
    const offset = parseInt(query.offset || '0', 10);

    const { approvals, total } = await this.approvalService.getPendingApprovals(tenantId, {
      limit,
      offset,
    });

    return {
      success: true,
      approvals: approvals.map((a) => this.formatApproval(a)),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + approvals.length < total,
      },
    };
  }

  /**
   * GET /api/v1/approvals/count
   * Get count of approvals by status (defaults to PENDING)
   * v1.0.1: Added to support frontend badge display
   */
  @Get('count')
  async getApprovalsCount(
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED',
    @Headers('X-Tenant-Id') tenantId?: string,
  ) {
    // Default to PENDING status if not specified
    const filterStatus = status || 'PENDING';

    // Note: For count endpoint, we allow requests without tenant ID
    // to support global badge counts. If tenant ID is provided,
    // we filter by tenant.
    const count = await this.approvalService.getApprovalCount(
      filterStatus,
      tenantId,
    );

    return {
      success: true,
      count,
    };
  }

  /**
   * GET /api/v1/approvals/:id
   * Get approval details by ID
   */
  @Get(':id')
  async getApproval(@Param('id') id: string) {
    const approval = await this.approvalService.getApprovalById(id);

    if (!approval) {
      throw new HttpException('Approval not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      approval: this.formatApprovalDetailed(approval),
    };
  }

  /**
   * POST /api/v1/approvals/:id/approve
   * Approve a high-risk action
   */
  @Post(':id/approve')
  async approveAction(
    @Param('id') id: string,
    @Body() body: ApproveActionDto,
    @Headers('X-User-Id') userId?: string,
  ) {
    if (!userId) {
      throw new HttpException('X-User-Id header required for approval', HttpStatus.BAD_REQUEST);
    }

    try {
      const approval = await this.approvalService.processDecision({
        approvalId: id,
        approved: true,
        reviewerId: userId,
        reason: body.reason,
      });

      this.logger.log(`Approval ${id} approved by ${userId}`);

      return {
        success: true,
        approval: this.formatApproval(approval),
        message: 'Action approved successfully. The workflow will resume execution.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to approve ${id}: ${error.message}`);

      if (error.message.includes('not pending')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      if (error.message.includes('expired')) {
        throw new HttpException(error.message, HttpStatus.GONE);
      }
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to approve action: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/approvals/:id/reject
   * Reject a high-risk action
   */
  @Post(':id/reject')
  async rejectAction(
    @Param('id') id: string,
    @Body() body: RejectActionDto,
    @Headers('X-User-Id') userId?: string,
  ) {
    if (!userId) {
      throw new HttpException('X-User-Id header required for rejection', HttpStatus.BAD_REQUEST);
    }

    if (!body.reason) {
      throw new HttpException('Rejection reason is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const approval = await this.approvalService.processDecision({
        approvalId: id,
        approved: false,
        reviewerId: userId,
        reason: body.reason,
      });

      this.logger.log(`Approval ${id} rejected by ${userId}: ${body.reason}`);

      return {
        success: true,
        approval: this.formatApproval(approval),
        message: 'Action rejected. The workflow node will be marked as failed.',
      };
    } catch (error: any) {
      this.logger.error(`Failed to reject ${id}: ${error.message}`);

      if (error.message.includes('not pending')) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      if (error.message.includes('expired')) {
        throw new HttpException(error.message, HttpStatus.GONE);
      }
      if (error.message.includes('not found')) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }

      throw new HttpException(
        `Failed to reject action: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/approvals/stats
   * Get approval and idempotency statistics
   */
  @Get('stats')
  async getStats(@Headers('X-Tenant-Id') tenantId?: string) {
    // Expire old approvals first
    const expiredCount = await this.approvalService.expireOldApprovals();

    // Get idempotency stats
    const idempotencyStats = await this.idempotencyService.getStats();

    // Get high-risk tool list
    const highRiskTools = this.highRiskService.getHighRiskToolNames();

    return {
      success: true,
      stats: {
        approvals: {
          expiredThisCheck: expiredCount,
        },
        idempotency: idempotencyStats,
        configuration: {
          highRiskTools,
        },
      },
    };
  }

  /**
   * POST /api/v1/approvals/cleanup
   * Clean up expired records (admin endpoint)
   */
  @Post('cleanup')
  async cleanup() {
    const expiredApprovals = await this.approvalService.expireOldApprovals();
    const expiredIdempotency = await this.idempotencyService.cleanupExpired();

    return {
      success: true,
      cleanup: {
        expiredApprovals,
        expiredIdempotencyRecords: expiredIdempotency,
      },
    };
  }

  /**
   * Format approval for list response
   */
  private formatApproval(approval: any) {
    const preview = approval.previewData || {};

    return {
      id: approval.id,
      status: approval.status,
      toolName: approval.toolName,
      summary: preview.summary || `Execute ${approval.toolName}`,
      category: preview.category || 'Other',
      riskLevel: preview.riskLevel || 'UNKNOWN',
      recipient: preview.recipient,
      subject: preview.subject,
      expiresAt: approval.expiresAt,
      createdAt: approval.createdAt,
      decision: approval.status !== ApprovalStatus.PENDING
        ? {
            by: approval.approvedBy || approval.rejectedBy,
            at: approval.approvedAt || approval.rejectedAt,
            reason: approval.reason,
          }
        : undefined,
    };
  }

  /**
   * Format approval for detailed response
   */
  private formatApprovalDetailed(approval: any) {
    const preview = approval.previewData || {};

    return {
      ...this.formatApproval(approval),
      nodeRunId: approval.nodeRunId,
      actionHash: approval.actionHash,
      toolParams: approval.toolParams,
      preview: {
        bodyPreview: preview.bodyPreview,
        context: preview.context,
        aiReasoning: preview.aiReasoning,
        confidenceScore: preview.confidenceScore,
        riskReason: preview.riskReason,
        workspaceId: preview.workspaceId,
        currentUrl: preview.currentUrl,
      },
    };
  }
}
