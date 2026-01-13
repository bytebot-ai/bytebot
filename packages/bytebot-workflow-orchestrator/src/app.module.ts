/**
 * App Module
 * v5.11.0: Advanced Enhancements V2 - Dashboard, Multi-Tenant Knowledge,
 *          Entity Resolution, Failure Prediction, Cross-Goal Learning
 * v5.10.0: Advanced Enhancements - Context Summarization, Knowledge Extraction,
 *          Background Mode, Checkpoint Persistence
 * v5.5.7: Added WorkspaceDbReconcilerService for K8s/DB drift reconciliation
 * v5.6.1: Added OrphanPodGCService for workspace cleanup
 * v5.6.0: Phase 4-5 Live Desktop Control APIs & Real-Time Event System
 * Root module for the Workflow Orchestrator
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TerminusModule } from '@nestjs/terminus';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';

// Services
import { PrismaService } from './services/prisma.service';
import { WorkflowService } from './services/workflow.service';
import { WorkspaceService } from './services/workspace.service';
import { SchedulerService } from './services/scheduler.service';
import { NodeExecutorService } from './services/node-executor.service';
// v1.0.3: Leader election for scheduler single-runner guarantee
import { LeaderElectionService } from './services/leader-election.service';
// v1.0.0 M5: High-risk gating and idempotency services
import { HighRiskService } from './services/high-risk.service';
import { ApprovalService } from './services/approval.service';
import { IdempotencyService } from './services/idempotency.service';
import { CleanupService } from './services/cleanup.service';
// v5.6.1: Orphan pod garbage collection
import { OrphanPodGCService } from './services/orphan-pod-gc.service';
// v5.5.7: Workspace DB reconciler for K8s/DB drift detection
import { WorkspaceDbReconcilerService } from './services/workspace-db-reconciler.service';
// Post-M5: Webhook notifications and audit logging
import { WebhookService } from './services/webhook.service';
import { AuditService } from './services/audit.service';
// Phase 7: Multi-Agent Orchestration services
import { AgentRegistryService } from './services/agent-registry.service';
import { AgentRouterService } from './services/agent-router.service';
import { AgentHealthService } from './services/agent-health.service';
// Phase 8: Advanced Analytics Dashboard services
import { MetricsCollectorService } from './services/metrics-collector.service';
import { MetricsAggregationService } from './services/metrics-aggregation.service';
import { AnalyticsQueryService } from './services/analytics-query.service';
// Phase 9: Self-Healing & Auto-Recovery services
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { TaskRecoveryService } from './services/task-recovery.service';
import { WorkflowCheckpointService } from './services/workflow-checkpoint.service';
import { DeadLetterQueueService } from './services/dead-letter-queue.service';
// Phase 10: Manus-Style Goal-First Orchestration services
	import { GoalRunService } from './services/goal-run.service';
	import { PlannerService } from './services/planner.service';
	import { GoalIntakeService } from './services/goal-intake.service';
	import { OrchestratorLoopService } from './services/orchestrator-loop.service';
	import { UserPromptService } from './services/user-prompt.service';
	import { JsonSchemaValidatorService } from './services/json-schema-validator.service';
	import { OutboxService } from './services/outbox.service';
	import { OutboxPublisherService } from './services/outbox-publisher.service';
	import { PromptResumeReconcilerService } from './services/prompt-resume-reconciler.service';
	import { InteractionSliMetricsService } from './services/interaction-sli-metrics.service';
	import { UserPromptResolutionService } from './services/user-prompt-resolution.service';
// Phase 7 (v5.2.0): Enhanced Features - Templates, Batch Execution
import { GoalTemplateService } from './services/goal-template.service';
import { BatchService } from './services/batch.service';
import { TemplateSeedService } from './services/template-seed.service';
// Phase 8 (v5.3.0): External Integrations - Slack, Teams, GitHub/GitLab
import { SlackNotificationService } from './services/slack-notification.service';
import { TeamsNotificationService } from './services/teams-notification.service';
import { GitIntegrationService } from './services/git-integration.service';
// Phase 9 (v5.4.0): Advanced AI Features - Goal Refinement, Template Generation, Failure Analysis
import { GoalRefinementService } from './services/goal-refinement.service';
import { TemplateGenerationService } from './services/template-generation.service';
import { FailureAnalysisService } from './services/failure-analysis.service';
// Phase 10 (v5.5.0): Enterprise Features - Multi-Tenant Admin, Audit Export, Compliance, SSO, LLM Providers
import { TenantAdminService } from './services/tenant-admin.service';
import { AuditExportService } from './services/audit-export.service';
import { ComplianceService } from './services/compliance.service';
import { SSOService } from './services/sso.service';
import { LLMProviderService } from './services/llm-provider.service';
// Phase 4 (v5.6.0): Live Desktop Control APIs
import { DesktopControlService } from './services/desktop-control.service';
// v5.6.9: Poll-based task dispatch adapter
import { TaskDispatchService } from './services/task-dispatch.service';
// v5.5.15: DB transient error resilience
import { DbTransientService } from './services/db-transient.service';
// v5.5.18 Phase E: Maintenance mode handling
import { MaintenanceModeService } from './services/maintenance-mode.service';
// v5.8.0: Option C Industry Standard - Failure classification for intelligent retry/replan
import { FailureClassificationService } from './services/failure-classification.service';
// v5.9.0: Context-Preserving Replanning - Manus-style checkpoint service
import { GoalCheckpointService } from './services/goal-checkpoint.service';
// v5.10.0: Advanced Enhancements - Context summarization, knowledge extraction, background mode
import { ContextSummarizationService } from './services/context-summarization.service';
import { KnowledgeExtractionService } from './services/knowledge-extraction.service';
import { BackgroundModeService } from './services/background-mode.service';
import { CheckpointPersistenceService } from './services/checkpoint-persistence.service';
// v5.11.0: Advanced Enhancements V2 - Dashboard, Multi-Tenant Knowledge, Entity Resolution, Failure Prediction, Cross-Goal Learning
import { DashboardService } from './services/dashboard.service';
import { TenantKnowledgeService } from './services/tenant-knowledge.service';
import { EntityResolutionService } from './services/entity-resolution.service';
import { FailurePredictionService } from './services/failure-prediction.service';
import { CrossGoalLearningService } from './services/cross-goal-learning.service';
// v5.12.0: Temporal Workflow Integration
import { TemporalModule } from './temporal/temporal.module';

// Gateways
// Phase 5 (v5.6.0): Real-Time Event System
import { RunEventsGateway } from './gateways/run-events.gateway';

// Controllers
import { HealthController } from './controllers/health.controller';
import { WorkflowController } from './controllers/workflow.controller';
import { WorkspaceProxyController } from './controllers/workspace-proxy.controller';
import { ApprovalController } from './controllers/approval.controller';
// Post-M5: Webhook and audit controllers
import { WebhookController } from './controllers/webhook.controller';
import { AuditController } from './controllers/audit.controller';
// Phase 7: Multi-Agent Orchestration controller
import { AgentController } from './controllers/agent.controller';
// Phase 8: Analytics controller
import { AnalyticsController } from './controllers/analytics.controller';
// Phase 9: Self-Healing controller
import { SelfHealingController } from './controllers/self-healing.controller';
// Phase 10: Manus-Style Goal-First Orchestration controller
import { GoalRunController } from './controllers/goal-run.controller';
// Phase 7 (v5.2.0): Enhanced Features controllers
import { TemplateController } from './controllers/template.controller';
import { BatchController } from './controllers/batch.controller';
// Phase 8 (v5.3.0): External Integrations controllers
import { NotificationController } from './controllers/notification.controller';
import { GitIntegrationController } from './controllers/git-integration.controller';
// Phase 9 (v5.4.0): Advanced AI Features controller
import { AiFeaturesController } from './controllers/ai-features.controller';
// Phase 10 (v5.5.0): Enterprise Features controller
import { EnterpriseController } from './controllers/enterprise.controller';
// Phase 4 (v5.6.0): Live Desktop Control APIs controller
import { DesktopControlController } from './controllers/desktop-control.controller';
// v5.10.0: Checkpoint Visualization API
import { CheckpointController } from './controllers/checkpoint.controller';
// v5.11.0: Dashboard Visualization API
import { DashboardController } from './controllers/dashboard.controller';
// v5.13.0 Phase 11.3: Internal API for Temporal worker integration
import { InternalController } from './controllers/internal.controller';
import { UserPromptController } from './controllers/user-prompt.controller';
import { EventsController } from './controllers/events.controller';

// Modules
import { MetricsModule } from './modules/metrics.module';

@Module({
  imports: [
    // Configuration from environment
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Scheduling for orchestration loop
    ScheduleModule.forRoot(),

    // Event emitter for workflow events
    EventEmitterModule.forRoot(),

    // Health checks
    TerminusModule,

    // Metrics
    MetricsModule,

    // Phase 5 (v5.6.0): JWT for WebSocket authentication
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'change-me-in-production',
      signOptions: { expiresIn: '24h' },
    }),

    // Phase 6: Rate limiting for API protection
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000, // 1 second
        limit: 10, // 10 requests per second
      },
      {
        name: 'medium',
        ttl: 10000, // 10 seconds
        limit: 50, // 50 requests per 10 seconds
      },
      {
        name: 'long',
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute
      },
    ]),

    // v5.12.0: Temporal Workflow Integration (conditionally connects based on TEMPORAL_WORKFLOW_ENABLED)
    TemporalModule,
  ],
  controllers: [
    HealthController,
    WorkflowController,
    WorkspaceProxyController,
    ApprovalController, // v1.0.0 M5: Approval management
    // Post-M5: Webhook and audit endpoints
    WebhookController,
    AuditController,
    // Phase 7: Multi-Agent Orchestration
    AgentController,
    // Phase 8: Analytics Dashboard
    AnalyticsController,
    // Phase 9: Self-Healing & Auto-Recovery
    SelfHealingController,
    // Phase 10: Manus-Style Goal-First Orchestration
    GoalRunController,
    // Phase 7 (v5.2.0): Enhanced Features
    TemplateController,
    BatchController,
    // Phase 8 (v5.3.0): External Integrations
    NotificationController,
    GitIntegrationController,
    // Phase 9 (v5.4.0): Advanced AI Features
    AiFeaturesController,
    // Phase 10 (v5.5.0): Enterprise Features
    EnterpriseController,
    // Phase 4 (v5.6.0): Live Desktop Control APIs
    DesktopControlController,
    // v5.10.0: Checkpoint Visualization API
    CheckpointController,
    // v5.11.0: Dashboard Visualization API
    DashboardController,
    // v5.13.0 Phase 11.3: Internal API for Temporal worker integration
    InternalController,
    UserPromptController,
    EventsController,
  ],
  providers: [
    PrismaService,
    // v5.5.15: DB transient error resilience (must be early, others depend on it)
    DbTransientService,
    WorkflowService,
    WorkspaceService,
    // v1.0.3: Leader election must be initialized before scheduler
    LeaderElectionService,
    // Phase 7: Multi-Agent Orchestration (must be before NodeExecutor)
    AgentRegistryService,
    AgentRouterService,
    AgentHealthService,
    // Phase 8: Analytics Dashboard (event-driven collection)
    MetricsCollectorService,
    MetricsAggregationService,
    AnalyticsQueryService,
    // Scheduler and executor
    SchedulerService,
    NodeExecutorService,
    // v1.0.0 M5: High-risk gating and idempotency
    HighRiskService,
    ApprovalService,
    IdempotencyService,
    CleanupService,
    // v5.6.1: Orphan pod garbage collection
    OrphanPodGCService,
    // v5.5.7: Workspace DB reconciler for K8s/DB drift detection
    WorkspaceDbReconcilerService,
    // Post-M5: Webhook notifications and audit logging
    WebhookService,
    AuditService,
    // Phase 9: Self-Healing & Auto-Recovery
    CircuitBreakerService,
    TaskRecoveryService,
    WorkflowCheckpointService,
    DeadLetterQueueService,
    // Phase 10: Manus-Style Goal-First Orchestration
    GoalRunService,
	    PlannerService,
	    GoalIntakeService,
	    UserPromptService,
	    JsonSchemaValidatorService,
	    OutboxService,
	    OutboxPublisherService,
	    PromptResumeReconcilerService,
	    InteractionSliMetricsService,
	    UserPromptResolutionService,
    // v5.5.18 Phase E: Maintenance mode (must be before orchestrator loop)
    MaintenanceModeService,
    // v5.8.0: Option C Industry Standard - Failure classification (must be before orchestrator loop)
    FailureClassificationService,
    // v5.9.0: Context-Preserving Replanning - Manus-style checkpoint (must be before orchestrator loop)
    GoalCheckpointService,
    // v5.10.0: Advanced Enhancements (must be before orchestrator loop)
    ContextSummarizationService,
    KnowledgeExtractionService,
    BackgroundModeService,
    CheckpointPersistenceService,
    // v5.11.0: Advanced Enhancements V2 (must be before orchestrator loop)
    DashboardService,
    TenantKnowledgeService,
    EntityResolutionService,
    FailurePredictionService,
    CrossGoalLearningService,
    OrchestratorLoopService,
    // Phase 7 (v5.2.0): Enhanced Features - Templates, Batch Execution
    GoalTemplateService,
    BatchService,
    TemplateSeedService, // Seeds built-in templates on startup
    // Phase 8 (v5.3.0): External Integrations - Slack, Teams, GitHub/GitLab
    SlackNotificationService,
    TeamsNotificationService,
    GitIntegrationService,
    // Phase 9 (v5.4.0): Advanced AI Features - Goal Refinement, Template Generation, Failure Analysis
    GoalRefinementService,
    TemplateGenerationService,
    FailureAnalysisService,
    // Phase 10 (v5.5.0): Enterprise Features - Multi-Tenant Admin, Audit Export, Compliance, SSO, LLM Providers
    TenantAdminService,
    AuditExportService,
    ComplianceService,
    SSOService,
    LLMProviderService,
    // Phase 4 (v5.6.0): Live Desktop Control APIs
    DesktopControlService,
    // v5.6.9: Poll-based task dispatch adapter
    TaskDispatchService,
    // Phase 5 (v5.6.0): Real-Time Event System Gateway
    RunEventsGateway,
    // Phase 6: Global rate limiting guard
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
