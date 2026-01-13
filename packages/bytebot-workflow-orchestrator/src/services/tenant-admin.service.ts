/**
 * Tenant Administration Service
 * Phase 10 (v5.5.0): Enterprise Features - Multi-Tenant Administration
 *
 * Provides comprehensive tenant management capabilities:
 * - Tenant CRUD operations
 * - Settings management
 * - Quota management and enforcement
 * - Usage tracking
 * - Plan/subscription management
 */

import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { createId } from '@paralleldrive/cuid2';

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum TenantPlan {
  FREE = 'free',
  STARTER = 'starter',
  PROFESSIONAL = 'professional',
  ENTERPRISE = 'enterprise',
}

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  PENDING = 'pending',
  CANCELLED = 'cancelled',
}

export interface CreateTenantInput {
  name: string;
  slug?: string;
  adminEmail: string;
  adminName?: string;
  companyName?: string;
  plan?: TenantPlan;
  billingEmail?: string;
  metadata?: Record<string, any>;
}

export interface UpdateTenantInput {
  name?: string;
  adminEmail?: string;
  adminName?: string;
  companyName?: string;
  billingEmail?: string;
  metadata?: Record<string, any>;
}

export interface TenantSettingsInput {
  timezone?: string;
  dateFormat?: string;
  defaultWorkspaceMode?: string;
  requireMfa?: boolean;
  sessionTimeout?: number;
  ipAllowlist?: string[];
  allowedDomains?: string[];
  maxConcurrentGoals?: number;
  defaultApprovalTimeout?: number;
  autoReplanEnabled?: boolean;
  maxReplanAttempts?: number;
  notificationEmail?: string;
  slackWebhookUrl?: string;
  teamsWebhookUrl?: string;
  auditLogRetentionDays?: number;
  goalRunRetentionDays?: number;
  features?: Record<string, any>;
}

export interface TenantQuotaInput {
  monthlyGoalRuns?: number;
  monthlyTokens?: number;
  storageLimit?: bigint;
  maxConcurrentWorkspaces?: number;
  maxUsersPerTenant?: number;
  maxTemplates?: number;
  maxBatchSize?: number;
  apiRateLimitPerMinute?: number;
}

export interface UsageStats {
  goalRuns: { used: number; limit: number; percentage: number };
  tokens: { used: number; limit: number; percentage: number };
  storage: { used: bigint; limit: bigint; percentage: number };
  periodStart: Date;
  daysRemaining: number;
}

// Plan limits configuration
const PLAN_LIMITS: Record<TenantPlan, TenantQuotaInput> = {
  [TenantPlan.FREE]: {
    monthlyGoalRuns: 100,
    monthlyTokens: 100000,
    storageLimit: BigInt(1073741824), // 1GB
    maxConcurrentWorkspaces: 2,
    maxUsersPerTenant: 3,
    maxTemplates: 10,
    maxBatchSize: 5,
    apiRateLimitPerMinute: 30,
  },
  [TenantPlan.STARTER]: {
    monthlyGoalRuns: 500,
    monthlyTokens: 500000,
    storageLimit: BigInt(5368709120), // 5GB
    maxConcurrentWorkspaces: 5,
    maxUsersPerTenant: 10,
    maxTemplates: 50,
    maxBatchSize: 20,
    apiRateLimitPerMinute: 60,
  },
  [TenantPlan.PROFESSIONAL]: {
    monthlyGoalRuns: 2000,
    monthlyTokens: 2000000,
    storageLimit: BigInt(21474836480), // 20GB
    maxConcurrentWorkspaces: 20,
    maxUsersPerTenant: 50,
    maxTemplates: 200,
    maxBatchSize: 50,
    apiRateLimitPerMinute: 100,
  },
  [TenantPlan.ENTERPRISE]: {
    monthlyGoalRuns: 10000,
    monthlyTokens: 10000000,
    storageLimit: BigInt(107374182400), // 100GB
    maxConcurrentWorkspaces: 100,
    maxUsersPerTenant: 500,
    maxTemplates: 1000,
    maxBatchSize: 100,
    apiRateLimitPerMinute: 500,
  },
};

@Injectable()
export class TenantAdminService {
  private readonly logger = new Logger(TenantAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.logger.log('TenantAdminService initialized');
  }

  // ==========================================================================
  // Tenant CRUD Operations
  // ==========================================================================

  /**
   * Create a new tenant with default settings and quotas
   */
  async createTenant(input: CreateTenantInput): Promise<any> {
    // Generate slug if not provided
    const slug = input.slug || this.generateSlug(input.name);

    // Check if slug already exists
    const existing = await this.prisma.tenant.findUnique({
      where: { slug },
    });

    if (existing) {
      throw new ConflictException(`Tenant with slug "${slug}" already exists`);
    }

    const plan = input.plan || TenantPlan.FREE;
    const planLimits = PLAN_LIMITS[plan];

    // Create tenant with settings and quotas in a transaction
    const tenant = await this.prisma.$transaction(async (tx) => {
      // Create tenant
      const newTenant = await tx.tenant.create({
        data: {
          name: input.name,
          slug,
          adminEmail: input.adminEmail,
          adminName: input.adminName,
          companyName: input.companyName,
          plan,
          billingEmail: input.billingEmail || input.adminEmail,
          status: TenantStatus.ACTIVE,
          metadata: input.metadata || {},
        },
      });

      // Create default settings
      await tx.tenantSettings.create({
        data: {
          tenantId: newTenant.id,
        },
      });

      // Create quotas based on plan
      await tx.tenantQuota.create({
        data: {
          tenantId: newTenant.id,
          monthlyGoalRuns: planLimits.monthlyGoalRuns!,
          monthlyTokens: planLimits.monthlyTokens!,
          storageLimit: planLimits.storageLimit!,
          maxConcurrentWorkspaces: planLimits.maxConcurrentWorkspaces!,
          maxUsersPerTenant: planLimits.maxUsersPerTenant!,
          maxTemplates: planLimits.maxTemplates!,
          maxBatchSize: planLimits.maxBatchSize!,
          apiRateLimitPerMinute: planLimits.apiRateLimitPerMinute!,
        },
      });

      return newTenant;
    });

    this.logger.log(`Created tenant: ${tenant.id} (${tenant.slug})`);
    this.eventEmitter.emit('tenant.created', { tenantId: tenant.id, plan });

    return this.getTenant(tenant.id);
  }

  /**
   * Get a tenant by ID with all related data
   */
  async getTenant(tenantId: string): Promise<any> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        settings: true,
        quotas: true,
        ssoConfig: true,
        llmProviders: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    return tenant;
  }

  /**
   * Get a tenant by slug
   */
  async getTenantBySlug(slug: string): Promise<any> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
      include: {
        settings: true,
        quotas: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with slug "${slug}" not found`);
    }

    return tenant;
  }

  /**
   * List all tenants with pagination and filtering
   */
  async listTenants(options: {
    status?: TenantStatus;
    plan?: TenantPlan;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ tenants: any[]; total: number }> {
    const where: any = {};

    if (options.status) {
      where.status = options.status;
    }

    if (options.plan) {
      where.plan = options.plan;
    }

    if (options.search) {
      where.OR = [
        { name: { contains: options.search, mode: 'insensitive' } },
        { slug: { contains: options.search, mode: 'insensitive' } },
        { adminEmail: { contains: options.search, mode: 'insensitive' } },
        { companyName: { contains: options.search, mode: 'insensitive' } },
      ];
    }

    const [tenants, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        include: {
          quotas: true,
        },
        orderBy: { createdAt: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return { tenants, total };
  }

  /**
   * Update a tenant
   */
  async updateTenant(tenantId: string, input: UpdateTenantInput): Promise<any> {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...input,
      },
      include: {
        settings: true,
        quotas: true,
      },
    });

    this.logger.log(`Updated tenant: ${tenantId}`);
    this.eventEmitter.emit('tenant.updated', { tenantId });

    return updated;
  }

  /**
   * Delete a tenant (soft delete by setting status to cancelled)
   */
  async deleteTenant(tenantId: string, hardDelete = false): Promise<void> {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    if (hardDelete) {
      // Hard delete - cascade will remove related records
      await this.prisma.tenant.delete({
        where: { id: tenantId },
      });
      this.logger.log(`Hard deleted tenant: ${tenantId}`);
    } else {
      // Soft delete
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { status: TenantStatus.CANCELLED },
      });
      this.logger.log(`Soft deleted tenant: ${tenantId}`);
    }

    this.eventEmitter.emit('tenant.deleted', { tenantId, hardDelete });
  }

  // ==========================================================================
  // Tenant Status Management
  // ==========================================================================

  /**
   * Suspend a tenant
   */
  async suspendTenant(tenantId: string, reason?: string): Promise<any> {
    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.SUSPENDED,
        metadata: {
          ...(await this.getTenantMetadata(tenantId)),
          suspendedAt: new Date().toISOString(),
          suspendReason: reason,
        },
      },
    });

    this.logger.log(`Suspended tenant: ${tenantId}, reason: ${reason}`);
    this.eventEmitter.emit('tenant.suspended', { tenantId, reason });

    return tenant;
  }

  /**
   * Reactivate a suspended tenant
   */
  async reactivateTenant(tenantId: string): Promise<any> {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    if (existing.status !== TenantStatus.SUSPENDED) {
      throw new BadRequestException('Only suspended tenants can be reactivated');
    }

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: TenantStatus.ACTIVE,
        metadata: {
          ...(existing.metadata as any),
          reactivatedAt: new Date().toISOString(),
        },
      },
    });

    this.logger.log(`Reactivated tenant: ${tenantId}`);
    this.eventEmitter.emit('tenant.reactivated', { tenantId });

    return tenant;
  }

  // ==========================================================================
  // Settings Management
  // ==========================================================================

  /**
   * Get tenant settings
   */
  async getSettings(tenantId: string): Promise<any> {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
    });

    if (!settings) {
      throw new NotFoundException(`Settings not found for tenant ${tenantId}`);
    }

    return settings;
  }

  /**
   * Update tenant settings
   */
  async updateSettings(tenantId: string, input: TenantSettingsInput): Promise<any> {
    // Validate tenant exists
    await this.getTenant(tenantId);

    const settings = await this.prisma.tenantSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        ...input,
      },
      update: input,
    });

    this.logger.log(`Updated settings for tenant: ${tenantId}`);
    this.eventEmitter.emit('tenant.settings.updated', { tenantId });

    return settings;
  }

  // ==========================================================================
  // Quota Management
  // ==========================================================================

  /**
   * Get tenant quotas
   */
  async getQuotas(tenantId: string): Promise<any> {
    const quotas = await this.prisma.tenantQuota.findUnique({
      where: { tenantId },
    });

    if (!quotas) {
      throw new NotFoundException(`Quotas not found for tenant ${tenantId}`);
    }

    return quotas;
  }

  /**
   * Update tenant quotas
   */
  async updateQuotas(tenantId: string, input: TenantQuotaInput): Promise<any> {
    // Validate tenant exists
    await this.getTenant(tenantId);

    const quotas = await this.prisma.tenantQuota.upsert({
      where: { tenantId },
      create: {
        tenantId,
        ...input,
      },
      update: input,
    });

    this.logger.log(`Updated quotas for tenant: ${tenantId}`);
    this.eventEmitter.emit('tenant.quotas.updated', { tenantId });

    return quotas;
  }

  /**
   * Get usage statistics for a tenant
   */
  async getUsageStats(tenantId: string): Promise<UsageStats> {
    const quotas = await this.getQuotas(tenantId);

    const periodStart = new Date(quotas.quotaPeriodStart);
    const now = new Date();
    const endOfPeriod = new Date(periodStart);
    endOfPeriod.setMonth(endOfPeriod.getMonth() + 1);

    const daysRemaining = Math.max(0, Math.ceil((endOfPeriod.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    return {
      goalRuns: {
        used: quotas.monthlyGoalRunsUsed,
        limit: quotas.monthlyGoalRuns,
        percentage: (quotas.monthlyGoalRunsUsed / quotas.monthlyGoalRuns) * 100,
      },
      tokens: {
        used: quotas.monthlyTokensUsed,
        limit: quotas.monthlyTokens,
        percentage: (quotas.monthlyTokensUsed / quotas.monthlyTokens) * 100,
      },
      storage: {
        used: quotas.storageUsed,
        limit: quotas.storageLimit,
        percentage: Number((quotas.storageUsed * BigInt(100)) / quotas.storageLimit),
      },
      periodStart,
      daysRemaining,
    };
  }

  /**
   * Check if tenant has quota available
   */
  async checkQuota(tenantId: string, resource: 'goalRuns' | 'tokens' | 'storage', amount: number): Promise<boolean> {
    const quotas = await this.getQuotas(tenantId);

    switch (resource) {
      case 'goalRuns':
        return quotas.monthlyGoalRunsUsed + amount <= quotas.monthlyGoalRuns;
      case 'tokens':
        return quotas.monthlyTokensUsed + amount <= quotas.monthlyTokens;
      case 'storage':
        return quotas.storageUsed + BigInt(amount) <= quotas.storageLimit;
      default:
        return false;
    }
  }

  /**
   * Increment usage for a resource
   */
  async incrementUsage(tenantId: string, resource: 'goalRuns' | 'tokens' | 'storage', amount: number): Promise<void> {
    const updateData: any = {};

    switch (resource) {
      case 'goalRuns':
        updateData.monthlyGoalRunsUsed = { increment: amount };
        break;
      case 'tokens':
        updateData.monthlyTokensUsed = { increment: amount };
        break;
      case 'storage':
        updateData.storageUsed = { increment: BigInt(amount) };
        break;
    }

    await this.prisma.tenantQuota.update({
      where: { tenantId },
      data: updateData,
    });
  }

  /**
   * Reset monthly quotas (called by scheduler)
   */
  async resetMonthlyQuotas(): Promise<number> {
    const now = new Date();
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const result = await this.prisma.tenantQuota.updateMany({
      where: {
        quotaPeriodStart: { lt: oneMonthAgo },
      },
      data: {
        monthlyGoalRunsUsed: 0,
        monthlyTokensUsed: 0,
        quotaPeriodStart: now,
      },
    });

    if (result.count > 0) {
      this.logger.log(`Reset quotas for ${result.count} tenants`);
    }

    return result.count;
  }

  // ==========================================================================
  // Plan Management
  // ==========================================================================

  /**
   * Upgrade/downgrade tenant plan
   */
  async changePlan(tenantId: string, newPlan: TenantPlan): Promise<any> {
    const tenant = await this.getTenant(tenantId);
    const oldPlan = tenant.plan;

    if (oldPlan === newPlan) {
      return tenant;
    }

    const planLimits = PLAN_LIMITS[newPlan];

    // Update plan and quotas
    await this.prisma.$transaction([
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { plan: newPlan },
      }),
      this.prisma.tenantQuota.update({
        where: { tenantId },
        data: {
          monthlyGoalRuns: planLimits.monthlyGoalRuns!,
          monthlyTokens: planLimits.monthlyTokens!,
          storageLimit: planLimits.storageLimit!,
          maxConcurrentWorkspaces: planLimits.maxConcurrentWorkspaces!,
          maxUsersPerTenant: planLimits.maxUsersPerTenant!,
          maxTemplates: planLimits.maxTemplates!,
          maxBatchSize: planLimits.maxBatchSize!,
          apiRateLimitPerMinute: planLimits.apiRateLimitPerMinute!,
        },
      }),
    ]);

    this.logger.log(`Changed plan for tenant ${tenantId}: ${oldPlan} -> ${newPlan}`);
    this.eventEmitter.emit('tenant.plan.changed', { tenantId, oldPlan, newPlan });

    return this.getTenant(tenantId);
  }

  /**
   * Get available plans with their limits
   */
  getAvailablePlans(): Record<TenantPlan, TenantQuotaInput> {
    return PLAN_LIMITS;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Generate URL-friendly slug from name
   */
  private generateSlug(name: string): string {
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Add random suffix to ensure uniqueness
    const suffix = createId().slice(0, 6);
    return `${baseSlug}-${suffix}`;
  }

  /**
   * Get tenant metadata
   */
  private async getTenantMetadata(tenantId: string): Promise<Record<string, any>> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { metadata: true },
    });
    return (tenant?.metadata as Record<string, any>) || {};
  }
}
