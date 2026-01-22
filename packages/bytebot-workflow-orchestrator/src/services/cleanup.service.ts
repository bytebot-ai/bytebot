/**
 * Cleanup Service
 * v1.0.0 M5: Scheduled cleanup of expired approvals and idempotency records
 * Post-M5: Also cleans up expired audit logs and webhook deliveries
 *
 * Runs periodically to:
 * - Expire old pending approvals
 * - Clean up expired idempotency records
 * - Clean up expired audit logs (based on retention policy)
 * - Clean up old webhook delivery records
 * - Reset stale processing records
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApprovalService } from './approval.service';
import { IdempotencyService } from './idempotency.service';
import { AuditService } from './audit.service';
import { PrismaService } from './prisma.service';

@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private isRunning = false;

  constructor(
    private readonly approvalService: ApprovalService,
    private readonly idempotencyService: IdempotencyService,
    private readonly prisma: PrismaService,
    @Optional() private readonly auditService?: AuditService,
  ) {
    this.logger.log('CleanupService initialized');
  }

  /**
   * Run cleanup every 5 minutes
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async runCleanup() {
    if (this.isRunning) {
      this.logger.debug('Cleanup already running, skipping');
      return;
    }

    this.isRunning = true;

    try {
      this.logger.debug('Starting cleanup cycle');

      // Expire old approvals
      const expiredApprovals = await this.approvalService.expireOldApprovals();

      // Clean up expired idempotency records
      const expiredIdempotency = await this.idempotencyService.cleanupExpired();

      // Post-M5: Clean up expired audit logs
      let expiredAuditLogs = 0;
      if (this.auditService) {
        try {
          expiredAuditLogs = await this.auditService.cleanupExpired();
        } catch (error: any) {
          // Table might not exist yet
          if (!error.message.includes('does not exist')) {
            this.logger.warn(`Audit cleanup failed: ${error.message}`);
          }
        }
      }

      // Post-M5: Clean up old webhook delivery records (older than 30 days)
      let cleanedWebhookDeliveries = 0;
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = await this.prisma.webhookDelivery.deleteMany({
          where: {
            createdAt: { lt: thirtyDaysAgo },
          },
        });
        cleanedWebhookDeliveries = result.count;
      } catch (error: any) {
        // Table might not exist yet
        if (!error.message.includes('does not exist')) {
          this.logger.warn(`Webhook delivery cleanup failed: ${error.message}`);
        }
      }

      const totalCleaned =
        expiredApprovals + expiredIdempotency + expiredAuditLogs + cleanedWebhookDeliveries;

      if (totalCleaned > 0) {
        this.logger.log(
          `Cleanup complete: ${expiredApprovals} approvals expired, ` +
            `${expiredIdempotency} idempotency records, ` +
            `${expiredAuditLogs} audit logs, ` +
            `${cleanedWebhookDeliveries} webhook deliveries cleaned`,
        );
      }
    } catch (error: any) {
      this.logger.error(`Cleanup failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Run full cleanup (can be called manually)
   */
  async runFullCleanup(): Promise<{
    expiredApprovals: number;
    expiredIdempotency: number;
    expiredAuditLogs: number;
    cleanedWebhookDeliveries: number;
  }> {
    const expiredApprovals = await this.approvalService.expireOldApprovals();
    const expiredIdempotency = await this.idempotencyService.cleanupExpired();

    let expiredAuditLogs = 0;
    if (this.auditService) {
      try {
        expiredAuditLogs = await this.auditService.cleanupExpired();
      } catch {
        // Table might not exist
      }
    }

    let cleanedWebhookDeliveries = 0;
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await this.prisma.webhookDelivery.deleteMany({
        where: {
          createdAt: { lt: thirtyDaysAgo },
        },
      });
      cleanedWebhookDeliveries = result.count;
    } catch {
      // Table might not exist
    }

    return {
      expiredApprovals,
      expiredIdempotency,
      expiredAuditLogs,
      cleanedWebhookDeliveries,
    };
  }
}
