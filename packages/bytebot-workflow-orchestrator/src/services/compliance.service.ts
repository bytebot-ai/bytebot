/**
 * Compliance Reporting Service
 * Phase 10 (v5.5.0): Enterprise Features - SOC2/GDPR Compliance
 *
 * Provides compliance reporting capabilities:
 * - SOC2 Trust Service Criteria reports
 * - GDPR Article 30 data processing records
 * - Data Subject Access Requests (DSAR)
 * - Data retention policy enforcement
 * - Automated compliance report generation
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum ReportType {
  SOC2_SECURITY = 'soc2_security',
  SOC2_AVAILABILITY = 'soc2_availability',
  SOC2_CONFIDENTIALITY = 'soc2_confidentiality',
  SOC2_PROCESSING_INTEGRITY = 'soc2_processing_integrity',
  SOC2_PRIVACY = 'soc2_privacy',
  GDPR_ARTICLE30 = 'gdpr_article30',
  GDPR_DSAR = 'gdpr_dsar',
  DATA_RETENTION = 'data_retention',
  ACCESS_REVIEW = 'access_review',
}

export enum LegalBasis {
  CONSENT = 'consent',
  CONTRACT = 'contract',
  LEGAL_OBLIGATION = 'legal_obligation',
  VITAL_INTERESTS = 'vital_interests',
  PUBLIC_TASK = 'public_task',
  LEGITIMATE_INTERESTS = 'legitimate_interests',
}

export interface GenerateReportInput {
  tenantId: string;
  reportType: ReportType;
  reportName?: string;
  startDate: Date;
  endDate: Date;
  generatedBy?: string;
}

export interface DataProcessingRecordInput {
  activityName: string;
  activityDescription?: string;
  dataSubjectCategories: string[];
  personalDataCategories: string[];
  legalBasis: LegalBasis;
  legalBasisDetails?: string;
  processingPurposes: string[];
  recipientCategories?: string[];
  thirdCountryTransfers?: string[];
  transferSafeguards?: string;
  retentionPeriod?: string;
  retentionCriteria?: string;
  technicalMeasures?: string[];
  organizationalMeasures?: string[];
}

export interface DSARRequest {
  tenantId: string;
  subjectEmail: string;
  subjectName?: string;
  requestType: 'access' | 'rectification' | 'erasure' | 'portability' | 'restriction' | 'objection';
  requestDetails?: string;
  verificationMethod?: string;
  verifiedAt?: Date;
}

// ============================================================================
// SOC2 Trust Service Criteria
// ============================================================================

const SOC2_CRITERIA = {
  security: [
    { id: 'CC1.1', name: 'Control Environment', description: 'Demonstrates commitment to integrity and ethical values' },
    { id: 'CC1.2', name: 'Board Oversight', description: 'Board exercises oversight responsibility' },
    { id: 'CC2.1', name: 'Information Communication', description: 'Internal communication of objectives' },
    { id: 'CC3.1', name: 'Risk Assessment', description: 'Identifies and analyzes risks' },
    { id: 'CC4.1', name: 'Monitoring', description: 'Evaluates and communicates deficiencies' },
    { id: 'CC5.1', name: 'Control Activities', description: 'Selects and develops control activities' },
    { id: 'CC6.1', name: 'Logical Access', description: 'Controls logical access to systems' },
    { id: 'CC6.6', name: 'System Operations', description: 'Manages changes to system components' },
    { id: 'CC7.1', name: 'Incident Detection', description: 'Detects and monitors security events' },
    { id: 'CC7.2', name: 'Incident Response', description: 'Responds to identified incidents' },
  ],
  availability: [
    { id: 'A1.1', name: 'Capacity Management', description: 'Maintains current capacity' },
    { id: 'A1.2', name: 'Recovery Planning', description: 'Plans for system recovery' },
  ],
  confidentiality: [
    { id: 'C1.1', name: 'Confidential Information', description: 'Identifies confidential information' },
    { id: 'C1.2', name: 'Disposal', description: 'Disposes of confidential information' },
  ],
  processing_integrity: [
    { id: 'PI1.1', name: 'Processing Accuracy', description: 'Ensures processing accuracy and completeness' },
  ],
  privacy: [
    { id: 'P1.1', name: 'Privacy Notice', description: 'Provides notice about privacy practices' },
    { id: 'P2.1', name: 'Choice and Consent', description: 'Obtains consent for data collection' },
    { id: 'P3.1', name: 'Collection', description: 'Collects personal information as disclosed' },
    { id: 'P4.1', name: 'Use and Retention', description: 'Uses and retains information appropriately' },
    { id: 'P5.1', name: 'Access', description: 'Provides access to personal information' },
    { id: 'P6.1', name: 'Disclosure', description: 'Discloses information to third parties as consented' },
    { id: 'P7.1', name: 'Quality', description: 'Maintains accurate personal information' },
    { id: 'P8.1', name: 'Monitoring', description: 'Monitors compliance with privacy policies' },
  ],
};

// ============================================================================
// Compliance Service
// ============================================================================

@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.logger.log('ComplianceService initialized');
  }

  // ==========================================================================
  // Report Generation
  // ==========================================================================

  /**
   * Generate a compliance report
   */
  async generateReport(input: GenerateReportInput): Promise<any> {
    const reportPeriod = this.formatReportPeriod(input.startDate, input.endDate);
    const reportName = input.reportName || `${input.reportType} Report - ${reportPeriod}`;

    // Create report record
    const report = await this.prisma.complianceReport.create({
      data: {
        tenantId: input.tenantId,
        reportType: input.reportType,
        reportName,
        reportPeriod,
        startDate: input.startDate,
        endDate: input.endDate,
        status: 'generating',
        generatedBy: input.generatedBy || 'system',
      },
    });

    try {
      // Generate report content based on type
      let findings: any[] = [];
      let metrics: Record<string, any> = {};
      let summary = '';

      switch (input.reportType) {
        case ReportType.SOC2_SECURITY:
          ({ findings, metrics, summary } = await this.generateSOC2SecurityReport(input));
          break;
        case ReportType.SOC2_AVAILABILITY:
          ({ findings, metrics, summary } = await this.generateSOC2AvailabilityReport(input));
          break;
        case ReportType.GDPR_ARTICLE30:
          ({ findings, metrics, summary } = await this.generateGDPRArticle30Report(input));
          break;
        case ReportType.DATA_RETENTION:
          ({ findings, metrics, summary } = await this.generateDataRetentionReport(input));
          break;
        case ReportType.ACCESS_REVIEW:
          ({ findings, metrics, summary } = await this.generateAccessReviewReport(input));
          break;
        default:
          ({ findings, metrics, summary } = await this.generateGenericReport(input));
      }

      // Update report with content
      const updatedReport = await this.prisma.complianceReport.update({
        where: { id: report.id },
        data: {
          findings,
          metrics,
          summary,
          status: 'completed',
          generatedAt: new Date(),
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
        },
      });

      this.eventEmitter.emit('compliance.report.generated', {
        tenantId: input.tenantId,
        reportId: report.id,
        reportType: input.reportType,
      });

      return updatedReport;
    } catch (error: any) {
      // Mark report as failed
      await this.prisma.complianceReport.update({
        where: { id: report.id },
        data: {
          status: 'failed',
          summary: `Report generation failed: ${error.message}`,
        },
      });

      throw error;
    }
  }

  /**
   * Get a compliance report by ID
   */
  async getReport(tenantId: string, reportId: string): Promise<any> {
    const report = await this.prisma.complianceReport.findFirst({
      where: { id: reportId, tenantId },
    });

    if (!report) {
      throw new NotFoundException(`Report ${reportId} not found`);
    }

    return report;
  }

  /**
   * List compliance reports for a tenant
   */
  async listReports(
    tenantId: string,
    options: {
      reportType?: ReportType;
      status?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ reports: any[]; total: number }> {
    const where: any = { tenantId };

    if (options.reportType) {
      where.reportType = options.reportType;
    }

    if (options.status) {
      where.status = options.status;
    }

    const [reports, total] = await Promise.all([
      this.prisma.complianceReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options.limit || 50,
        skip: options.offset || 0,
      }),
      this.prisma.complianceReport.count({ where }),
    ]);

    return { reports, total };
  }

  // ==========================================================================
  // GDPR Data Processing Records
  // ==========================================================================

  /**
   * Create a data processing record (GDPR Article 30)
   */
  async createDataProcessingRecord(tenantId: string, input: DataProcessingRecordInput): Promise<any> {
    const record = await this.prisma.dataProcessingRecord.create({
      data: {
        tenantId,
        activityName: input.activityName,
        activityDescription: input.activityDescription,
        dataSubjectCategories: input.dataSubjectCategories,
        personalDataCategories: input.personalDataCategories,
        legalBasis: input.legalBasis,
        legalBasisDetails: input.legalBasisDetails,
        processingPurposes: input.processingPurposes,
        recipientCategories: input.recipientCategories || [],
        thirdCountryTransfers: input.thirdCountryTransfers || [],
        transferSafeguards: input.transferSafeguards,
        retentionPeriod: input.retentionPeriod,
        retentionCriteria: input.retentionCriteria,
        technicalMeasures: input.technicalMeasures || [],
        organizationalMeasures: input.organizationalMeasures || [],
        status: 'active',
      },
    });

    this.logger.log(`Created data processing record: ${record.id}`);
    return record;
  }

  /**
   * Update a data processing record
   */
  async updateDataProcessingRecord(
    tenantId: string,
    recordId: string,
    input: Partial<DataProcessingRecordInput>,
  ): Promise<any> {
    const existing = await this.prisma.dataProcessingRecord.findFirst({
      where: { id: recordId, tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Data processing record ${recordId} not found`);
    }

    return this.prisma.dataProcessingRecord.update({
      where: { id: recordId },
      data: input,
    });
  }

  /**
   * List data processing records
   */
  async listDataProcessingRecords(
    tenantId: string,
    options: { status?: string; legalBasis?: LegalBasis } = {},
  ): Promise<any[]> {
    const where: any = { tenantId };

    if (options.status) {
      where.status = options.status;
    }

    if (options.legalBasis) {
      where.legalBasis = options.legalBasis;
    }

    return this.prisma.dataProcessingRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  // ==========================================================================
  // Data Subject Access Requests (DSAR)
  // ==========================================================================

  /**
   * Process a Data Subject Access Request
   */
  async processDSAR(request: DSARRequest): Promise<{
    requestId: string;
    dataFound: boolean;
    personalData: any;
    processingActivities: any[];
  }> {
    const requestId = `dsar-${Date.now()}`;

    this.logger.log(`Processing DSAR for ${request.subjectEmail} (type: ${request.requestType})`);

    // Find all data related to this subject
    const personalData = await this.findSubjectData(request.tenantId, request.subjectEmail);

    // Find processing activities that apply to this subject
    const processingActivities = await this.prisma.dataProcessingRecord.findMany({
      where: {
        tenantId: request.tenantId,
        status: 'active',
      },
    });

    // Create DSAR report
    await this.prisma.complianceReport.create({
      data: {
        tenantId: request.tenantId,
        reportType: ReportType.GDPR_DSAR,
        reportName: `DSAR - ${request.subjectEmail} - ${request.requestType}`,
        reportPeriod: new Date().toISOString().split('T')[0],
        startDate: new Date(),
        endDate: new Date(),
        status: 'completed',
        generatedAt: new Date(),
        summary: `Data Subject Access Request for ${request.subjectEmail}`,
        findings: [
          {
            requestType: request.requestType,
            subjectEmail: request.subjectEmail,
            dataCategories: Object.keys(personalData),
            processingActivitiesCount: processingActivities.length,
          },
        ],
        metrics: {
          dataPointsFound: this.countDataPoints(personalData),
          processingActivities: processingActivities.length,
        },
        generatedBy: 'system',
      },
    });

    this.eventEmitter.emit('compliance.dsar.processed', {
      tenantId: request.tenantId,
      requestId,
      requestType: request.requestType,
      subjectEmail: request.subjectEmail,
    });

    return {
      requestId,
      dataFound: Object.keys(personalData).length > 0,
      personalData,
      processingActivities: processingActivities.map(p => ({
        activity: p.activityName,
        purpose: p.processingPurposes,
        legalBasis: p.legalBasis,
        retention: p.retentionPeriod,
      })),
    };
  }

  /**
   * Execute data erasure (right to be forgotten)
   */
  async executeDataErasure(
    tenantId: string,
    subjectEmail: string,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    erasedCategories: string[];
    retainedCategories: string[];
    retentionReasons: Record<string, string>;
  }> {
    const erasedCategories: string[] = [];
    const retainedCategories: string[] = [];
    const retentionReasons: Record<string, string> = {};

    // Categories that must be retained for legal compliance
    const mandatoryRetention = ['audit_logs', 'billing_records', 'legal_holds'];

    if (!options.dryRun) {
      // Anonymize user data in various tables
      // This is a simplified example - actual implementation would be more comprehensive

      // Anonymize audit logs related to this user (actor email)
      await this.prisma.auditLog.updateMany({
        where: { tenantId, actorEmail: subjectEmail },
        data: { actorEmail: 'anonymized@example.com', actorName: 'Anonymized User' },
      });
      erasedCategories.push('audit_logs_actor_data');

      // Note: Audit event records are retained for compliance, only PII is anonymized
      retainedCategories.push('audit_log_events');
      retentionReasons['audit_log_events'] = 'Legal compliance requirement - events retained, PII anonymized';
    }

    this.logger.log(`Data erasure ${options.dryRun ? '(dry run)' : ''} for ${subjectEmail}: erased ${erasedCategories.length} categories`);

    return { erasedCategories, retainedCategories, retentionReasons };
  }

  // ==========================================================================
  // Report Generation Helpers
  // ==========================================================================

  private async generateSOC2SecurityReport(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    const criteria = SOC2_CRITERIA.security;
    const findings: any[] = [];

    // Gather metrics from audit logs
    const auditStats = await this.prisma.auditLog.groupBy({
      by: ['eventType'],
      where: {
        tenantId: input.tenantId,
        timestamp: { gte: input.startDate, lte: input.endDate },
      },
      _count: true,
    });

    // Evaluate each criterion
    for (const criterion of criteria) {
      const status = await this.evaluateSOC2Criterion(input.tenantId, criterion.id, input.startDate, input.endDate);
      findings.push({
        criterionId: criterion.id,
        name: criterion.name,
        description: criterion.description,
        status: status.status,
        evidence: status.evidence,
        recommendations: status.recommendations,
      });
    }

    const passedCount = findings.filter(f => f.status === 'pass').length;
    const totalCount = findings.length;

    return {
      findings,
      metrics: {
        criteriaEvaluated: totalCount,
        criteriaPassed: passedCount,
        criteriaFailed: totalCount - passedCount,
        complianceScore: Math.round((passedCount / totalCount) * 100),
        auditEvents: auditStats.reduce((acc, s) => ({ ...acc, [s.eventType]: s._count }), {}),
      },
      summary: `SOC2 Security evaluation: ${passedCount}/${totalCount} criteria passed (${Math.round((passedCount / totalCount) * 100)}% compliant)`,
    };
  }

  private async generateSOC2AvailabilityReport(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    const findings = SOC2_CRITERIA.availability.map(c => ({
      criterionId: c.id,
      name: c.name,
      description: c.description,
      status: 'needs_review',
      evidence: [],
      recommendations: ['Manual review required'],
    }));

    return {
      findings,
      metrics: { criteriaCount: findings.length },
      summary: `SOC2 Availability report generated with ${findings.length} criteria for review`,
    };
  }

  private async generateGDPRArticle30Report(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    const records = await this.prisma.dataProcessingRecord.findMany({
      where: { tenantId: input.tenantId, status: 'active' },
    });

    const findings = records.map(r => ({
      activityName: r.activityName,
      dataCategories: r.personalDataCategories,
      legalBasis: r.legalBasis,
      purposes: r.processingPurposes,
      retention: r.retentionPeriod,
      transfers: r.thirdCountryTransfers,
      safeguards: r.transferSafeguards,
    }));

    const byLegalBasis = records.reduce((acc: Record<string, number>, r) => {
      acc[r.legalBasis] = (acc[r.legalBasis] || 0) + 1;
      return acc;
    }, {});

    return {
      findings,
      metrics: {
        totalProcessingActivities: records.length,
        byLegalBasis,
        hasThirdCountryTransfers: records.some(r => r.thirdCountryTransfers.length > 0),
      },
      summary: `GDPR Article 30 report: ${records.length} processing activities documented`,
    };
  }

  private async generateDataRetentionReport(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    // Get counts of data by age
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const [goalRunsRecent, goalRunsOld, auditLogsRecent, auditLogsOld] = await Promise.all([
      this.prisma.goalRun.count({ where: { tenantId: input.tenantId, createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.goalRun.count({ where: { tenantId: input.tenantId, createdAt: { lt: ninetyDaysAgo } } }),
      this.prisma.auditLog.count({ where: { tenantId: input.tenantId, timestamp: { gte: thirtyDaysAgo } } }),
      this.prisma.auditLog.count({ where: { tenantId: input.tenantId, timestamp: { lt: oneYearAgo } } }),
    ]);

    return {
      findings: [
        { category: 'goal_runs', recent: goalRunsRecent, old: goalRunsOld, retentionPolicy: '90 days' },
        { category: 'audit_logs', recent: auditLogsRecent, old: auditLogsOld, retentionPolicy: '365 days' },
      ],
      metrics: {
        totalGoalRuns: goalRunsRecent + goalRunsOld,
        totalAuditLogs: auditLogsRecent + auditLogsOld,
        oldDataPercentage: {
          goalRuns: goalRunsOld > 0 ? Math.round((goalRunsOld / (goalRunsRecent + goalRunsOld)) * 100) : 0,
          auditLogs: auditLogsOld > 0 ? Math.round((auditLogsOld / (auditLogsRecent + auditLogsOld)) * 100) : 0,
        },
      },
      summary: `Data retention report: ${goalRunsOld} goal runs and ${auditLogsOld} audit logs exceed retention policy`,
    };
  }

  private async generateAccessReviewReport(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    // Get unique actors from audit logs
    const actors = await this.prisma.auditLog.groupBy({
      by: ['actorId', 'actorEmail', 'actorType'],
      where: {
        tenantId: input.tenantId,
        timestamp: { gte: input.startDate, lte: input.endDate },
      },
      _count: true,
    });

    const findings = actors
      .filter(a => a.actorId)
      .map(a => ({
        actorId: a.actorId,
        actorEmail: a.actorEmail,
        actorType: a.actorType,
        actionCount: a._count,
        status: 'needs_review',
      }));

    return {
      findings,
      metrics: {
        uniqueActors: findings.length,
        totalActions: actors.reduce((sum, a) => sum + a._count, 0),
        byActorType: actors.reduce((acc: Record<string, number>, a) => {
          acc[a.actorType] = (acc[a.actorType] || 0) + a._count;
          return acc;
        }, {}),
      },
      summary: `Access review: ${findings.length} unique actors performed actions during the period`,
    };
  }

  private async generateGenericReport(input: GenerateReportInput): Promise<{
    findings: any[];
    metrics: Record<string, any>;
    summary: string;
  }> {
    return {
      findings: [],
      metrics: {},
      summary: `Generic compliance report for ${input.reportType}`,
    };
  }

  private async evaluateSOC2Criterion(
    tenantId: string,
    criterionId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{ status: string; evidence: string[]; recommendations: string[] }> {
    // This is a simplified evaluation - real implementation would be more comprehensive
    const evidence: string[] = [];
    const recommendations: string[] = [];

    switch (criterionId) {
      case 'CC6.1': // Logical Access
        const accessEvents = await this.prisma.auditLog.count({
          where: {
            tenantId,
            timestamp: { gte: startDate, lte: endDate },
            eventType: { in: ['APPROVAL_APPROVED', 'APPROVAL_REJECTED'] },
          },
        });
        evidence.push(`${accessEvents} access control events logged`);
        return { status: accessEvents > 0 ? 'pass' : 'needs_evidence', evidence, recommendations };

      case 'CC7.1': // Incident Detection
        const auditCount = await this.prisma.auditLog.count({
          where: { tenantId, timestamp: { gte: startDate, lte: endDate } },
        });
        evidence.push(`${auditCount} audit events captured`);
        return { status: auditCount > 0 ? 'pass' : 'needs_evidence', evidence, recommendations };

      default:
        recommendations.push('Manual review required for this criterion');
        return { status: 'needs_review', evidence, recommendations };
    }
  }

  private async findSubjectData(tenantId: string, email: string): Promise<Record<string, any>> {
    const data: Record<string, any> = {};

    // Find audit logs
    const auditLogs = await this.prisma.auditLog.findMany({
      where: { tenantId, actorEmail: email },
      take: 100,
    });
    if (auditLogs.length > 0) {
      data.auditLogs = auditLogs.map(l => ({
        timestamp: l.timestamp,
        eventType: l.eventType,
        resourceType: l.resourceType,
      }));
    }

    // Note: GoalRun model doesn't have user attribution
    // Goal runs are tenant-scoped, not user-scoped in the current schema
    // If user attribution is needed, extend the GoalRun model with a userId field

    return data;
  }

  private countDataPoints(data: Record<string, any>): number {
    return Object.values(data).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 1), 0);
  }

  private formatReportPeriod(startDate: Date, endDate: Date): string {
    const start = startDate.toISOString().split('T')[0];
    const end = endDate.toISOString().split('T')[0];
    return `${start}_to_${end}`;
  }

  /**
   * Get available report types
   */
  getReportTypes(): Array<{ type: ReportType; name: string; description: string }> {
    return [
      { type: ReportType.SOC2_SECURITY, name: 'SOC2 Security', description: 'SOC2 Trust Service Criteria - Security' },
      { type: ReportType.SOC2_AVAILABILITY, name: 'SOC2 Availability', description: 'SOC2 Trust Service Criteria - Availability' },
      { type: ReportType.SOC2_CONFIDENTIALITY, name: 'SOC2 Confidentiality', description: 'SOC2 Trust Service Criteria - Confidentiality' },
      { type: ReportType.GDPR_ARTICLE30, name: 'GDPR Article 30', description: 'Records of processing activities' },
      { type: ReportType.GDPR_DSAR, name: 'GDPR DSAR', description: 'Data Subject Access Request report' },
      { type: ReportType.DATA_RETENTION, name: 'Data Retention', description: 'Data retention policy compliance' },
      { type: ReportType.ACCESS_REVIEW, name: 'Access Review', description: 'User access review report' },
    ];
  }
}
