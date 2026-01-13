/**
 * Enterprise Controller
 * Phase 10 (v5.5.0): Enterprise Features
 *
 * REST API endpoints for enterprise features:
 * - Tenant administration
 * - Audit log export
 * - Compliance reporting
 * - SSO configuration
 * - LLM provider management
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  IsArray,
  IsEnum,
  IsNumber,
  IsEmail,
  MinLength,
  Min,
  Max,
} from 'class-validator';
import {
  TenantAdminService,
  TenantPlan,
  TenantStatus,
  CreateTenantInput,
  UpdateTenantInput,
  TenantSettingsInput,
  TenantQuotaInput,
} from '../services/tenant-admin.service';
import {
  AuditExportService,
  ExportFormat,
} from '../services/audit-export.service';
import {
  ComplianceService,
  ReportType,
  LegalBasis,
  DataProcessingRecordInput,
} from '../services/compliance.service';
import { SSOService, SSOProvider, SSOConfigInput } from '../services/sso.service';
import { LLMProviderService, LLMProvider, ProviderConfig } from '../services/llm-provider.service';

// ============================================================================
// DTOs with class-validator decorators for ValidationPipe compatibility
// ============================================================================

/**
 * DTO for creating a tenant
 */
class CreateTenantDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  slug?: string;

  @IsEmail()
  adminEmail!: string;

  @IsOptional()
  @IsString()
  adminName?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsEnum(TenantPlan)
  plan?: TenantPlan;

  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

/**
 * DTO for updating a tenant
 */
class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsEmail()
  adminEmail?: string;

  @IsOptional()
  @IsString()
  adminName?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

/**
 * DTO for suspending a tenant
 */
class SuspendTenantDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * DTO for tenant settings
 */
class TenantSettingsDto {
  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  dateFormat?: string;

  @IsOptional()
  @IsString()
  defaultWorkspaceMode?: string;

  @IsOptional()
  @IsBoolean()
  requireMfa?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(60)
  @Max(86400)
  sessionTimeout?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipAllowlist?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  maxConcurrentGoals?: number;

  @IsOptional()
  @IsNumber()
  defaultApprovalTimeout?: number;

  @IsOptional()
  @IsBoolean()
  autoReplanEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxReplanAttempts?: number;

  @IsOptional()
  @IsEmail()
  notificationEmail?: string;

  @IsOptional()
  @IsString()
  slackWebhookUrl?: string;

  @IsOptional()
  @IsString()
  teamsWebhookUrl?: string;

  @IsOptional()
  @IsNumber()
  @Min(7)
  @Max(365)
  auditLogRetentionDays?: number;

  @IsOptional()
  @IsNumber()
  @Min(7)
  @Max(365)
  goalRunRetentionDays?: number;

  @IsOptional()
  @IsObject()
  features?: Record<string, any>;
}

/**
 * DTO for tenant quotas
 */
class TenantQuotaDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyGoalRuns?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyTokens?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  storageLimit?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxConcurrentWorkspaces?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxUsersPerTenant?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxTemplates?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxBatchSize?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  apiRateLimitPerMinute?: number;
}

/**
 * DTO for changing tenant plan
 */
class ChangePlanDto {
  @IsEnum(TenantPlan)
  plan!: TenantPlan;
}

/**
 * DTO for generating compliance report
 */
class GenerateReportDto {
  @IsEnum(ReportType)
  reportType!: ReportType;

  @IsOptional()
  @IsString()
  reportName?: string;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;
}

/**
 * DTO for DSAR request types
 */
enum DSARRequestType {
  ACCESS = 'access',
  RECTIFICATION = 'rectification',
  ERASURE = 'erasure',
  PORTABILITY = 'portability',
  RESTRICTION = 'restriction',
  OBJECTION = 'objection',
}

/**
 * DTO for DSAR processing
 */
class ProcessDSARDto {
  @IsEmail()
  subjectEmail!: string;

  @IsOptional()
  @IsString()
  subjectName?: string;

  @IsEnum(DSARRequestType)
  requestType!: DSARRequestType;

  @IsOptional()
  @IsString()
  requestDetails?: string;
}

/**
 * DTO for data processing record
 */
class DataProcessingRecordDto {
  @IsString()
  @MinLength(3)
  activityName!: string;

  @IsOptional()
  @IsString()
  activityDescription?: string;

  @IsArray()
  @IsString({ each: true })
  dataSubjectCategories!: string[];

  @IsArray()
  @IsString({ each: true })
  personalDataCategories!: string[];

  @IsEnum(LegalBasis)
  legalBasis!: LegalBasis;

  @IsOptional()
  @IsString()
  legalBasisDetails?: string;

  @IsArray()
  @IsString({ each: true })
  processingPurposes!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipientCategories?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  thirdCountryTransfers?: string[];

  @IsOptional()
  @IsString()
  transferSafeguards?: string;

  @IsOptional()
  @IsString()
  retentionPeriod?: string;

  @IsOptional()
  @IsString()
  retentionCriteria?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  technicalMeasures?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  organizationalMeasures?: string[];
}

/**
 * DTO for SAML configuration
 */
class SAMLConfigDto {
  @IsString()
  entityId!: string;

  @IsString()
  ssoUrl!: string;

  @IsOptional()
  @IsString()
  sloUrl?: string;

  @IsString()
  certificate!: string;

  @IsOptional()
  @IsString()
  signatureAlgorithm?: 'sha256' | 'sha512';
}

/**
 * DTO for attribute mapping
 */
class AttributeMappingDto {
  @IsString()
  email!: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  groups?: string;

  @IsOptional()
  @IsString()
  role?: string;
}

/**
 * DTO for SSO configuration
 */
class SSOConfigDto {
  @IsEnum(SSOProvider)
  provider!: SSOProvider;

  @IsOptional()
  @IsObject()
  saml?: SAMLConfigDto;

  @IsOptional()
  @IsObject()
  attributeMapping?: AttributeMappingDto;

  @IsOptional()
  @IsBoolean()
  jitProvisioning?: boolean;

  @IsOptional()
  @IsString()
  defaultRole?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enforcedDomains?: string[];

  @IsOptional()
  @IsBoolean()
  allowBypassSSO?: boolean;
}

/**
 * DTO for LLM provider configuration
 */
class LLMProviderConfigDto {
  @IsEnum(LLMProvider)
  provider!: LLMProvider;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  apiEndpoint?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isFallback?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxRequestsPerMinute?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxTokensPerRequest?: number;
}

/**
 * DTO for enabling/disabling provider
 */
class SetProviderEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

// ============================================================================
// Enterprise Controller
// ============================================================================

@ApiTags('enterprise')
@Controller('enterprise')
export class EnterpriseController {
  constructor(
    private readonly tenantAdminService: TenantAdminService,
    private readonly auditExportService: AuditExportService,
    private readonly complianceService: ComplianceService,
    private readonly ssoService: SSOService,
    private readonly llmProviderService: LLMProviderService,
  ) {}

  // ==========================================================================
  // Tenant Administration Endpoints
  // ==========================================================================

  @Post('tenants')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a new tenant' })
  @ApiResponse({ status: 201, description: 'Tenant created successfully' })
  async createTenant(@Body() dto: CreateTenantDto) {
    const input: CreateTenantInput = dto;
    const tenant = await this.tenantAdminService.createTenant(input);
    return { success: true, data: tenant };
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List all tenants' })
  @ApiQuery({ name: 'status', required: false, enum: TenantStatus })
  @ApiQuery({ name: 'plan', required: false, enum: TenantPlan })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async listTenants(
    @Query('status') status?: TenantStatus,
    @Query('plan') plan?: TenantPlan,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.tenantAdminService.listTenants({
      status,
      plan,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return { success: true, ...result };
  }

  @Get('tenants/:tenantId')
  @ApiOperation({ summary: 'Get tenant details' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID' })
  async getTenant(@Param('tenantId') tenantId: string) {
    const tenant = await this.tenantAdminService.getTenant(tenantId);
    return { success: true, data: tenant };
  }

  @Put('tenants/:tenantId')
  @ApiOperation({ summary: 'Update tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID' })
  async updateTenant(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantDto,
  ) {
    const input: UpdateTenantInput = dto;
    const tenant = await this.tenantAdminService.updateTenant(tenantId, input);
    return { success: true, data: tenant };
  }

  @Delete('tenants/:tenantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID' })
  @ApiQuery({ name: 'hard', required: false, description: 'Perform hard delete' })
  async deleteTenant(
    @Param('tenantId') tenantId: string,
    @Query('hard') hard?: string,
  ) {
    await this.tenantAdminService.deleteTenant(tenantId, hard === 'true');
  }

  @Post('tenants/:tenantId/suspend')
  @ApiOperation({ summary: 'Suspend a tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID' })
  async suspendTenant(
    @Param('tenantId') tenantId: string,
    @Body() dto: SuspendTenantDto,
  ) {
    const tenant = await this.tenantAdminService.suspendTenant(tenantId, dto.reason);
    return { success: true, data: tenant };
  }

  @Post('tenants/:tenantId/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended tenant' })
  @ApiParam({ name: 'tenantId', description: 'Tenant ID' })
  async reactivateTenant(@Param('tenantId') tenantId: string) {
    const tenant = await this.tenantAdminService.reactivateTenant(tenantId);
    return { success: true, data: tenant };
  }

  @Get('tenants/:tenantId/settings')
  @ApiOperation({ summary: 'Get tenant settings' })
  async getTenantSettings(@Param('tenantId') tenantId: string) {
    const settings = await this.tenantAdminService.getSettings(tenantId);
    return { success: true, data: settings };
  }

  @Put('tenants/:tenantId/settings')
  @ApiOperation({ summary: 'Update tenant settings' })
  async updateTenantSettings(
    @Param('tenantId') tenantId: string,
    @Body() dto: TenantSettingsDto,
  ) {
    const input: TenantSettingsInput = dto;
    const settings = await this.tenantAdminService.updateSettings(tenantId, input);
    return { success: true, data: settings };
  }

  @Get('tenants/:tenantId/quotas')
  @ApiOperation({ summary: 'Get tenant quotas' })
  async getTenantQuotas(@Param('tenantId') tenantId: string) {
    const quotas = await this.tenantAdminService.getQuotas(tenantId);
    return { success: true, data: quotas };
  }

  @Put('tenants/:tenantId/quotas')
  @ApiOperation({ summary: 'Update tenant quotas' })
  async updateTenantQuotas(
    @Param('tenantId') tenantId: string,
    @Body() dto: TenantQuotaDto,
  ) {
    // Convert storageLimit from number to bigint if provided
    const input: TenantQuotaInput = {
      ...dto,
      storageLimit: dto.storageLimit !== undefined ? BigInt(dto.storageLimit) : undefined,
    };
    const quotas = await this.tenantAdminService.updateQuotas(tenantId, input);
    return { success: true, data: quotas };
  }

  @Get('tenants/:tenantId/usage')
  @ApiOperation({ summary: 'Get tenant usage statistics' })
  async getTenantUsage(@Param('tenantId') tenantId: string) {
    const usage = await this.tenantAdminService.getUsageStats(tenantId);
    return { success: true, data: usage };
  }

  @Post('tenants/:tenantId/plan')
  @ApiOperation({ summary: 'Change tenant plan' })
  async changeTenantPlan(
    @Param('tenantId') tenantId: string,
    @Body() dto: ChangePlanDto,
  ) {
    const tenant = await this.tenantAdminService.changePlan(tenantId, dto.plan);
    return { success: true, data: tenant };
  }

  @Get('plans')
  @ApiOperation({ summary: 'Get available plans' })
  getAvailablePlans() {
    return { success: true, data: this.tenantAdminService.getAvailablePlans() };
  }

  // ==========================================================================
  // Audit Export Endpoints
  // ==========================================================================

  @Get('audit/export')
  @ApiOperation({ summary: 'Export audit logs' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  @ApiQuery({ name: 'format', required: false, enum: ExportFormat })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'eventTypes', required: false })
  async exportAuditLogs(
    @Headers('x-tenant-id') tenantId: string,
    @Query('format') format?: ExportFormat,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('eventTypes') eventTypes?: string,
    @Res() res?: Response,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const exportFormat = format || ExportFormat.JSON;
    const result = await this.auditExportService.exportToString({
      tenantId,
      format: exportFormat,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      eventTypes: eventTypes ? eventTypes.split(',') : undefined,
    });

    const contentType = {
      [ExportFormat.JSON]: 'application/json',
      [ExportFormat.CSV]: 'text/csv',
      [ExportFormat.NDJSON]: 'application/x-ndjson',
      [ExportFormat.SPLUNK]: 'application/json',
      [ExportFormat.ELASTICSEARCH]: 'application/x-ndjson',
    }[exportFormat];

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `audit-logs-${timestamp}.${exportFormat}`;

    if (res) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(result.data);
    }
  }

  @Get('audit/export/stream')
  @ApiOperation({ summary: 'Stream export audit logs (for large datasets)' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async streamAuditLogs(
    @Headers('x-tenant-id') tenantId: string,
    @Query('format') format?: ExportFormat,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<StreamableFile> {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const exportFormat = format || ExportFormat.NDJSON;
    const stream = this.auditExportService.createExportStream({
      tenantId,
      format: exportFormat,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `audit-logs-${timestamp}.${exportFormat}`;

    if (res) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    return new StreamableFile(stream);
  }

  @Get('audit/stats')
  @ApiOperation({ summary: 'Get audit export statistics' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async getAuditStats(
    @Headers('x-tenant-id') tenantId: string,
    @Query('days') days?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const stats = await this.auditExportService.getExportStats(
      tenantId,
      days ? parseInt(days, 10) : 30,
    );
    return { success: true, data: stats };
  }

  // ==========================================================================
  // Compliance Endpoints
  // ==========================================================================

  @Post('compliance/reports')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Generate a compliance report' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async generateComplianceReport(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: GenerateReportDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const report = await this.complianceService.generateReport({
      tenantId,
      reportType: dto.reportType,
      reportName: dto.reportName,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
    });

    return { success: true, data: report };
  }

  @Get('compliance/reports')
  @ApiOperation({ summary: 'List compliance reports' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async listComplianceReports(
    @Headers('x-tenant-id') tenantId: string,
    @Query('reportType') reportType?: ReportType,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const result = await this.complianceService.listReports(tenantId, {
      reportType,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return { success: true, ...result };
  }

  @Get('compliance/reports/:reportId')
  @ApiOperation({ summary: 'Get compliance report details' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async getComplianceReport(
    @Headers('x-tenant-id') tenantId: string,
    @Param('reportId') reportId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const report = await this.complianceService.getReport(tenantId, reportId);
    return { success: true, data: report };
  }

  @Get('compliance/report-types')
  @ApiOperation({ summary: 'Get available report types' })
  getReportTypes() {
    return { success: true, data: this.complianceService.getReportTypes() };
  }

  @Post('compliance/processing-records')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create GDPR data processing record' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async createProcessingRecord(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: DataProcessingRecordDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const input: DataProcessingRecordInput = dto;
    const record = await this.complianceService.createDataProcessingRecord(tenantId, input);
    return { success: true, data: record };
  }

  @Get('compliance/processing-records')
  @ApiOperation({ summary: 'List GDPR data processing records' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async listProcessingRecords(
    @Headers('x-tenant-id') tenantId: string,
    @Query('status') status?: string,
    @Query('legalBasis') legalBasis?: LegalBasis,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const records = await this.complianceService.listDataProcessingRecords(tenantId, {
      status,
      legalBasis,
    });

    return { success: true, data: records };
  }

  @Post('compliance/dsar')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'Process Data Subject Access Request' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async processDSAR(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: ProcessDSARDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const result = await this.complianceService.processDSAR({
      tenantId,
      ...dto,
    });

    return { success: true, data: result };
  }

  // ==========================================================================
  // SSO Endpoints
  // ==========================================================================

  @Post('sso/configure')
  @ApiOperation({ summary: 'Configure SSO for tenant' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async configureSSO(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: SSOConfigDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const input: SSOConfigInput = dto;
    const config = await this.ssoService.configureSSOv(tenantId, input);
    return { success: true, data: config };
  }

  @Get('sso/config')
  @ApiOperation({ summary: 'Get SSO configuration' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async getSSOConfig(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const config = await this.ssoService.getSSOConfig(tenantId);
    return { success: true, data: config };
  }

  @Post('sso/verify')
  @ApiOperation({ summary: 'Verify SSO configuration' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async verifySSOConfig(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const result = await this.ssoService.verifySSOConfig(tenantId);
    return { success: true, ...result };
  }

  @Post('sso/enable')
  @ApiOperation({ summary: 'Enable SSO' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async enableSSO(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const config = await this.ssoService.enableSSO(tenantId);
    return { success: true, data: config };
  }

  @Post('sso/disable')
  @ApiOperation({ summary: 'Disable SSO' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async disableSSO(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const config = await this.ssoService.disableSSO(tenantId);
    return { success: true, data: config };
  }

  @Get('sso/metadata/:tenantId')
  @ApiOperation({ summary: 'Get SP metadata XML' })
  async getSPMetadata(@Param('tenantId') tenantId: string, @Res() res: Response) {
    const xml = await this.ssoService.generateSPMetadataXML(tenantId);
    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  }

  @Get('sso/attribute-mappings')
  @ApiOperation({ summary: 'Get default attribute mappings' })
  getAttributeMappings() {
    return { success: true, data: this.ssoService.getDefaultAttributeMappings() };
  }

  // ==========================================================================
  // LLM Provider Endpoints
  // ==========================================================================

  @Post('llm/providers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Configure LLM provider' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async configureProvider(
    @Headers('x-tenant-id') tenantId: string,
    @Body() dto: LLMProviderConfigDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const input: ProviderConfig = dto;
    const config = await this.llmProviderService.configureProvider(tenantId, input);
    return { success: true, data: config };
  }

  @Get('llm/providers')
  @ApiOperation({ summary: 'List configured LLM providers' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async listProviders(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const providers = await this.llmProviderService.getProviders(tenantId);
    return { success: true, data: providers };
  }

  @Delete('llm/providers/:providerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete LLM provider' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async deleteProvider(
    @Headers('x-tenant-id') tenantId: string,
    @Param('providerId') providerId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    await this.llmProviderService.deleteProvider(tenantId, providerId);
  }

  @Post('llm/providers/:providerId/test')
  @ApiOperation({ summary: 'Test LLM provider configuration' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async testProvider(
    @Headers('x-tenant-id') tenantId: string,
    @Param('providerId') providerId: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const result = await this.llmProviderService.testProvider(tenantId, providerId);
    return result;
  }

  @Put('llm/providers/:providerId/enabled')
  @ApiOperation({ summary: 'Enable/disable LLM provider' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async setProviderEnabled(
    @Headers('x-tenant-id') tenantId: string,
    @Param('providerId') providerId: string,
    @Body() dto: SetProviderEnabledDto,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const result = await this.llmProviderService.setProviderEnabled(tenantId, providerId, dto.enabled);
    return { success: true, ...result };
  }

  @Get('llm/usage')
  @ApiOperation({ summary: 'Get LLM usage statistics' })
  @ApiHeader({ name: 'x-tenant-id', required: true })
  async getLLMUsage(@Headers('x-tenant-id') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header required');
    }

    const usage = await this.llmProviderService.getUsageStats(tenantId);
    return { success: true, data: usage };
  }

  @Get('llm/available-providers')
  @ApiOperation({ summary: 'Get available LLM providers' })
  getAvailableProviders() {
    return { success: true, data: this.llmProviderService.getAvailableProviders() };
  }
}
