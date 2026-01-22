import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createId } from '@paralleldrive/cuid2';
import {
  ActorType,
  ChecklistItemStatus,
  GoalRunPhase,
  GoalSpecStatus,
  Prisma,
  StepType,
  UserPromptKind,
  UserPromptScope,
  UserPromptStatus,
} from '@prisma/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter, Histogram } from 'prom-client';
import { PrismaService } from './prisma.service';
import { AuditService, AuditEventType } from './audit.service';
import { JsonSchemaValidatorService } from './json-schema-validator.service';

@Injectable()
export class UserPromptResolutionService {
  private readonly logger = new Logger(UserPromptResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly jsonSchemaValidator: JsonSchemaValidatorService,
    @InjectMetric('user_prompt_time_to_resolve_seconds')
    private readonly userPromptTimeToResolveSeconds: Histogram<string>,
    @InjectMetric('prompt_resolved_total')
    private readonly promptResolvedTotal: Counter<string>,
    @InjectMetric('goal_intake_completed_total')
    private readonly goalIntakeCompletedTotal: Counter<string>,
    @InjectMetric('resume_outbox_enqueued_total')
    private readonly resumeOutboxEnqueuedTotal: Counter<string>,
    @InjectMetric('user_prompt_resolution_validation_fail_total')
    private readonly validationFailTotal: Counter<string>,
    @InjectMetric('user_prompt_resolution_unauthorized_total')
    private readonly unauthorizedTotal: Counter<string>,
    @InjectMetric('user_prompt_resolution_incomplete_after_apply_total')
    private readonly incompleteAfterApplyTotal: Counter<string>,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private evaluateResolutionAuthz(params: {
    promptKind: UserPromptKind;
    actorType: ActorType;
  }): { allowed: true; policy: string; ruleId: string; reason: string } | { allowed: false; policy: string; ruleId: string; reason: string } {
    const policy = 'prompt_resolution.v1';

    // Approvals are governance objects: human-only unless explicitly expanded by policy (not yet).
    if (params.promptKind === UserPromptKind.APPROVAL) {
      if (params.actorType !== ActorType.HUMAN) {
        return {
          allowed: false,
          policy,
          ruleId: 'approval_human_only',
          reason: 'Only HUMAN actors may resolve approval prompts',
        };
      }
      return { allowed: true, policy, ruleId: 'approval_human_only', reason: 'HUMAN actor approved/denied approval prompt' };
    }

    // Desktop takeover prompts require a real human at the controls by default.
    if (params.promptKind === UserPromptKind.DESKTOP_TAKEOVER) {
      if (params.actorType !== ActorType.HUMAN) {
        return {
          allowed: false,
          policy,
          ruleId: 'desktop_takeover_human_only',
          reason: 'Only HUMAN actors may resolve desktop takeover prompts',
        };
      }
      return { allowed: true, policy, ruleId: 'desktop_takeover_human_only', reason: 'HUMAN actor resolved desktop takeover prompt' };
    }

    // Text-only prompts: parent agents may answer by policy (human fallback remains supported).
    if (
      params.actorType === ActorType.PARENT_AGENT ||
      params.actorType === ActorType.AGENT
    ) {
      return { allowed: true, policy, ruleId: 'parent_agent_text_only', reason: 'Agent actor allowed for text-only prompt kinds' };
    }

    // System automation: allowed for non-approval, non-takeover prompts.
    if (params.actorType === ActorType.SYSTEM) {
      return { allowed: true, policy, ruleId: 'system_text_only', reason: 'SYSTEM actor allowed for text-only prompt kinds' };
    }

    // Default allow for HUMAN.
    return { allowed: true, policy, ruleId: 'human_default', reason: 'HUMAN actor allowed' };
  }

  private validateAnswersAgainstJsonSchema(jsonSchema: any, answers: Record<string, any>): {
    isValid: boolean;
    errors: Array<{ path: string; message: string }>;
  } {
    const errors: Array<{ path: string; message: string }> = [];

    if (!jsonSchema || typeof jsonSchema !== 'object') {
      return { isValid: true, errors };
    }

    if (jsonSchema.type && jsonSchema.type !== 'object') {
      return { isValid: true, errors };
    }

    const required: string[] = Array.isArray(jsonSchema.required) ? jsonSchema.required : [];
    const properties: Record<string, any> =
      jsonSchema.properties && typeof jsonSchema.properties === 'object' ? jsonSchema.properties : {};

    for (const key of required) {
      const value = (answers as any)[key];
      if (value === undefined || value === null) {
        errors.push({ path: `/${key}`, message: 'is required' });
        continue;
      }

      const prop = properties[key];
      const expectedType = prop?.type;

      if (expectedType === 'string') {
        if (typeof value !== 'string') {
          errors.push({ path: `/${key}`, message: 'must be a string' });
          continue;
        }
        const minLength = typeof prop?.minLength === 'number' ? prop.minLength : undefined;
        if (minLength !== undefined && value.trim().length < minLength) {
          errors.push({ path: `/${key}`, message: `must be at least ${minLength} characters` });
        }
      }

      if (expectedType === 'number' || expectedType === 'integer') {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push({ path: `/${key}`, message: 'must be a number' });
        }
      }

      if (expectedType === 'boolean') {
        if (typeof value !== 'boolean') {
          errors.push({ path: `/${key}`, message: 'must be a boolean' });
        }
      }
    }

    return { isValid: errors.length === 0, errors };
  }

  private async recordAttemptOnce(params: {
    promptId: string;
    tenantId: string;
    goalRunId: string;
    actor: {
      type: ActorType;
      id?: string;
      email?: string;
      name?: string;
      authContext?: Record<string, any>;
    };
    answers: Record<string, any>;
    requestId?: string;
    clientRequestId?: string;
    idempotencyKey?: string;
    ipAddress?: string;
    userAgent?: string;
    authz: { decision: 'ALLOW' | 'DENY'; policy: string; ruleId: string; reason: string };
    isValid: boolean;
    validationResult?: Record<string, any> | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    // Idempotency: prompt-scoped; prefer idempotencyKey, fallback to clientRequestId.
    const idempotencyKey = params.idempotencyKey ?? null;
    const clientRequestId = params.clientRequestId ?? null;

    try {
      await this.prisma.userPromptAttempt.create({
        data: {
          id: createId(),
          promptId: params.promptId,
          tenantId: params.tenantId,
          goalRunId: params.goalRunId,
          actorType: params.actor.type,
          actorId: params.actor.id,
          actorEmail: params.actor.email,
          actorName: params.actor.name,
          actorIpAddress: params.ipAddress,
          actorUserAgent: params.userAgent,
          requestId: params.requestId,
          authContext: params.actor.authContext ?? {},
          clientRequestId,
          idempotencyKey,
          authzDecision: params.authz.decision,
          authzPolicy: params.authz.policy,
          authzRuleId: params.authz.ruleId,
          authzReason: params.authz.reason,
          answers: params.answers,
          isValid: params.isValid,
          validationResult: params.validationResult ?? undefined,
          errorCode: params.errorCode ?? null,
          errorMessage: params.errorMessage ?? null,
        },
      });
    } catch (error: any) {
      // P2002: unique constraint violation (prompt_id+idempotency_key or prompt_id+client_request_id)
      if (error?.code !== 'P2002') {
        throw error;
      }

      if (!idempotencyKey && !clientRequestId) {
        // Should be unreachable, but don't loop if it happens.
        return;
      }

      const existing = await this.prisma.userPromptAttempt.findFirst({
        where: {
          promptId: params.promptId,
          OR: [
            ...(idempotencyKey ? [{ idempotencyKey }] : []),
            ...(clientRequestId ? [{ clientRequestId }] : []),
          ],
        },
        select: { id: true },
      });

      if (existing) return;
      throw error;
    }
  }

  async resolvePrompt(request: {
    promptId: string;
    tenantId: string;
    actor: {
      type: ActorType;
      id?: string;
      email?: string;
      name?: string;
      authContext?: Record<string, any>;
    };
    answers: Record<string, any>;
    requestId?: string;
    clientRequestId?: string;
    idempotencyKey?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{
    promptId: string;
    goalRunId: string;
    checklistItemId?: string | null;
    goalSpecId?: string | null;
    didResolve: boolean;
    promptStatus: UserPromptStatus;
    promptKind: UserPromptKind;
  }> {
    if (!request.tenantId) throw new BadRequestException('tenantId is required');
    if (!request.actor?.type) throw new BadRequestException('actor.type is required');

    if (request.actor.type === ActorType.HUMAN) {
      if (!request.actor.id && !request.actor.email) {
        throw new BadRequestException('actor.id or actor.email is required for HUMAN');
      }
    } else if (request.actor.type === ActorType.AGENT || request.actor.type === ActorType.PARENT_AGENT) {
      if (!request.actor.id) throw new BadRequestException('actor.id is required for AGENT');
    } else if (request.actor.type === ActorType.SYSTEM) {
      if (!request.actor.id) throw new BadRequestException('actor.id is required for SYSTEM');
    }

    const { promptId } = request;
    const resolvedAt = new Date();

    // Preflight: record an immutable attempt row even when we reject the submission.
    // This is intentionally not part of the resolution transaction so validation/auth failures persist.
    const promptForAttempt = await this.prisma.userPrompt.findUnique({
      where: { id: promptId },
      select: {
        id: true,
        tenantId: true,
        goalRunId: true,
        goalSpecId: true,
        kind: true,
        status: true,
      },
    });

    if (!promptForAttempt) {
      throw new NotFoundException(`UserPrompt ${promptId} not found`);
    }

    const promptTenantIdForAttempt =
      promptForAttempt.tenantId ||
      (
        await this.prisma.goalRun.findUnique({
          where: { id: promptForAttempt.goalRunId },
          select: { tenantId: true },
        })
      )?.tenantId;

    if (!promptTenantIdForAttempt) {
      throw new BadRequestException(`Prompt ${promptId} is missing tenantId`);
    }
    if (promptTenantIdForAttempt !== request.tenantId) {
      // Do not record attempts across tenants (avoid leaking prompt existence).
      throw new ForbiddenException('Prompt does not belong to tenant');
    }

    const authzForAttempt = this.evaluateResolutionAuthz({
      promptKind: promptForAttempt.kind,
      actorType: request.actor.type,
    });

    if (!authzForAttempt.allowed) {
      await this.recordAttemptOnce({
        promptId,
        tenantId: promptTenantIdForAttempt,
        goalRunId: promptForAttempt.goalRunId,
        actor: request.actor,
        answers: request.answers,
        requestId: request.requestId,
        clientRequestId: request.clientRequestId,
        idempotencyKey: request.idempotencyKey,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        authz: { decision: 'DENY', policy: authzForAttempt.policy, ruleId: authzForAttempt.ruleId, reason: authzForAttempt.reason },
        isValid: false,
        validationResult: null,
        errorCode: 'AUTHZ_DENY',
        errorMessage: authzForAttempt.reason,
      });
      throw new ForbiddenException(authzForAttempt.reason);
    }

    if (promptForAttempt.status !== UserPromptStatus.OPEN && promptForAttempt.status !== UserPromptStatus.RESOLVED) {
      await this.recordAttemptOnce({
        promptId,
        tenantId: promptTenantIdForAttempt,
        goalRunId: promptForAttempt.goalRunId,
        actor: request.actor,
        answers: request.answers,
        requestId: request.requestId,
        clientRequestId: request.clientRequestId,
        idempotencyKey: request.idempotencyKey,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        authz: { decision: 'ALLOW', policy: authzForAttempt.policy, ruleId: authzForAttempt.ruleId, reason: authzForAttempt.reason },
        isValid: false,
        validationResult: null,
        errorCode: 'PROMPT_NOT_OPEN',
        errorMessage: `Prompt is not OPEN (status=${promptForAttempt.status})`,
      });
      throw new ConflictException(`Prompt ${promptId} is not OPEN (status=${promptForAttempt.status})`);
    }

    // Schema validation (GoalSpec-backed prompts only): reject invalid attempts but keep prompt OPEN.
    if (promptForAttempt.goalSpecId) {
      const goalSpec = await this.prisma.goalSpec.findUnique({
        where: { id: promptForAttempt.goalSpecId },
        select: { jsonSchema: true },
      });

      const { isValid, errors } = this.validateAnswersAgainstJsonSchema(goalSpec?.jsonSchema as any, request.answers);
      if (!isValid) {
        const validationResult = { schema: 'jsonschema.required+types.v1', errors };
        await this.recordAttemptOnce({
          promptId,
          tenantId: promptTenantIdForAttempt,
          goalRunId: promptForAttempt.goalRunId,
          actor: request.actor,
          answers: request.answers,
          requestId: request.requestId,
          clientRequestId: request.clientRequestId,
          idempotencyKey: request.idempotencyKey,
          ipAddress: request.ipAddress,
          userAgent: request.userAgent,
          authz: { decision: 'ALLOW', policy: authzForAttempt.policy, ruleId: authzForAttempt.ruleId, reason: authzForAttempt.reason },
          isValid: false,
          validationResult,
          errorCode: 'SCHEMA_VALIDATION_FAILED',
          errorMessage: 'Schema validation failed',
        });
        throw new BadRequestException({
          message: 'Schema validation failed',
          errors,
        });
      }
    }

    // Record accepted attempt (append-only).
    await this.recordAttemptOnce({
      promptId,
      tenantId: promptTenantIdForAttempt,
      goalRunId: promptForAttempt.goalRunId,
      actor: request.actor,
      answers: request.answers,
      requestId: request.requestId,
      clientRequestId: request.clientRequestId,
      idempotencyKey: request.idempotencyKey,
      ipAddress: request.ipAddress,
      userAgent: request.userAgent,
      authz: { decision: 'ALLOW', policy: authzForAttempt.policy, ruleId: authzForAttempt.ruleId, reason: authzForAttempt.reason },
      isValid: true,
      validationResult: null,
      errorCode: null,
      errorMessage: null,
    });

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock the prompt row to ensure OPEN->RESOLVED is serialized across concurrent resolvers.
      // This keeps derived updates (GoalSpec, outbox rows) single-writer and retry-safe.
      const locked = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM workflow_orchestrator.user_prompts WHERE id = ${promptId} FOR UPDATE`,
      );
      if (!locked?.length) {
        throw new NotFoundException(`UserPrompt ${promptId} not found`);
      }

      const prompt = await tx.userPrompt.findUnique({ where: { id: promptId } });

      if (!prompt) {
        throw new NotFoundException(`UserPrompt ${promptId} not found`);
      }

      // Enforce tenant boundary (RBAC baseline).
      const promptTenantId = prompt.tenantId || (
        await tx.goalRun.findUnique({ where: { id: prompt.goalRunId }, select: { tenantId: true } })
      )?.tenantId;

      if (!promptTenantId) {
        throw new BadRequestException(`Prompt ${promptId} is missing tenantId`);
      }
      if (promptTenantId !== request.tenantId) {
        throw new ForbiddenException('Prompt does not belong to tenant');
      }

      const authz = this.evaluateResolutionAuthz({ promptKind: prompt.kind, actorType: request.actor.type });
      if (!authz.allowed) {
        try {
          this.unauthorizedTotal.labels(prompt.kind, request.actor.type).inc();
        } catch {
          // ignore metric failures
        }
        throw new ForbiddenException(authz.reason);
      }

      // Idempotent: resolving twice is a no-op.
      if (prompt.status === UserPromptStatus.RESOLVED) {
        return { prompt, didResolve: false, phaseChanged: false, previousPhase: null as GoalRunPhase | null };
      }
      if (prompt.status !== UserPromptStatus.OPEN) {
        throw new ConflictException(`Prompt ${promptId} is not OPEN (status=${prompt.status})`);
      }

      // Validate answers against the prompt's schema snapshot (fail-closed).
      // - Patch validation: validate only provided fields (no required enforcement)
      // - Full validation: validate merged state to prove completeness before resolving
      const hasSchemaSnapshot = prompt.jsonSchema != null;
      if (prompt.kind === UserPromptKind.GOAL_INTAKE && !hasSchemaSnapshot) {
        throw new InternalServerErrorException('GOAL_INTAKE prompt is missing json_schema snapshot');
      }

      if (hasSchemaSnapshot) {
        const patchSchema = this.jsonSchemaValidator.makePatchSchema(prompt.jsonSchema as any);
        const patchResult = this.jsonSchemaValidator.validate(patchSchema as any, request.answers);
        if (!patchResult.valid) {
          try {
            this.validationFailTotal.labels(prompt.kind, prompt.scope).inc();
          } catch {
            // ignore metric failures
          }
          throw new UnprocessableEntityException({
            code: 'VALIDATION_FAILED',
            message: 'answers failed JSON schema validation',
            details: patchResult.violations,
          });
        }
      }

      let checklistItemDescription: string | null = null;

      if (prompt.checklistItemId) {
        const checklistItem = await tx.checklistItem.findUnique({
          where: { id: prompt.checklistItemId },
          select: { type: true, description: true },
        });

        if (!checklistItem) {
          throw new NotFoundException(`ChecklistItem ${prompt.checklistItemId} not found`);
        }

        checklistItemDescription = checklistItem.description;

        // "Unblock step" semantics:
        // - USER_INPUT_REQUIRED: answering satisfies the step → mark COMPLETED.
        // - EXECUTE: user answers unblock execution → mark PENDING (executor decides how to resume).
        if (checklistItem.type === StepType.USER_INPUT_REQUIRED) {
          await tx.checklistItem.updateMany({
            where: {
              id: prompt.checklistItemId,
              status: ChecklistItemStatus.BLOCKED,
            },
            data: {
              status: ChecklistItemStatus.COMPLETED,
              completedAt: resolvedAt,
              actualOutcome: JSON.stringify(
                {
                  promptId,
                  answers: request.answers,
                },
                null,
                2,
              ),
            },
          });
        } else {
          await tx.checklistItem.updateMany({
            where: {
              id: prompt.checklistItemId,
              status: ChecklistItemStatus.BLOCKED,
            },
            data: {
              status: ChecklistItemStatus.PENDING,
              startedAt: null,
              completedAt: null,
            },
          });
        }
      }

      if (prompt.goalSpecId) {
        const goalSpec = await tx.goalSpec.findUnique({
          where: { id: prompt.goalSpecId },
          select: { values: true, status: true },
        });

        const mergedValues = {
          ...(goalSpec?.values as any),
          ...(request.answers as any),
        };

        // Full validation: completeness is proven against the prompt's schema snapshot.
        // If incomplete, keep prompt OPEN and keep GoalSpec INCOMPLETE (no false RESOLVED).
        if (prompt.kind === UserPromptKind.GOAL_INTAKE) {
          const fullResult = this.jsonSchemaValidator.validate(prompt.jsonSchema as any, mergedValues);
          if (!fullResult.valid) {
            try {
              this.incompleteAfterApplyTotal.labels(prompt.kind).inc();
            } catch {
              // ignore metric failures
            }

            // Persist partial progress, but keep GoalSpec INCOMPLETE and do not resolve the prompt.
            await tx.goalSpec.update({
              where: { id: prompt.goalSpecId },
              data: {
                values: mergedValues,
                status: GoalSpecStatus.INCOMPLETE,
                completedAt: null,
              },
            });

            throw new ConflictException({
              code: 'INCOMPLETE_AFTER_APPLY',
              message: 'GoalSpec is still incomplete after applying answers',
              missingFields: fullResult.missingFields,
              details: fullResult.violations,
            });
          }
        }

        // GoalSpec is complete (or this is a non-intake prompt linked to GoalSpec).
        await tx.goalSpec.update({
          where: { id: prompt.goalSpecId },
          data: {
            values: mergedValues,
            status: GoalSpecStatus.COMPLETE,
            completedAt: resolvedAt,
          },
        });
      }

      // Resolution record is written only on success (idempotency keys consumed only on success).
      // Immutable resolution record (unique per promptId)
      try {
        await tx.userPromptResolution.create({
          data: {
            id: createId(),
            promptId,
            tenantId: promptTenantId,
            goalRunId: prompt.goalRunId,
            actorType: request.actor.type,
            actorId: request.actor.id,
            actorEmail: request.actor.email,
            actorName: request.actor.name,
            actorIpAddress: request.ipAddress,
            actorUserAgent: request.userAgent,
            requestId: request.requestId,
            authContext: request.actor.authContext ?? {},
            clientRequestId: request.clientRequestId,
            idempotencyKey: request.idempotencyKey,
            authzDecision: 'ALLOW',
            authzPolicy: authz.policy,
            authzRuleId: authz.ruleId,
            authzReason: authz.reason,
            answers: request.answers,
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }

      const updatedCount = await tx.userPrompt.updateMany({
        where: { id: promptId, status: UserPromptStatus.OPEN },
        data: {
          status: UserPromptStatus.RESOLVED,
          answers: request.answers,
          resolvedAt,
        },
      });

      if (updatedCount.count === 0) {
        const current = await tx.userPrompt.findUnique({ where: { id: promptId } });
        if (current?.status === UserPromptStatus.RESOLVED) {
          return { prompt: current, didResolve: false, phaseChanged: false, previousPhase: null as GoalRunPhase | null };
        }
        throw new ConflictException(`Prompt ${promptId} could not be resolved (status changed concurrently)`);
      }

      const updatedPrompt = await tx.userPrompt.findUnique({ where: { id: promptId } });
      if (!updatedPrompt) throw new NotFoundException(`UserPrompt ${promptId} not found after resolve`);

      const goalRun = await tx.goalRun.findUnique({
        where: { id: prompt.goalRunId },
        select: { phase: true, tenantId: true },
      });

      if (!goalRun) {
        throw new NotFoundException(`GoalRun ${prompt.goalRunId} not found`);
      }

      const nextPhase =
        prompt.goalSpecId || prompt.kind === UserPromptKind.GOAL_INTAKE
          ? GoalRunPhase.INITIALIZING
          : prompt.kind === UserPromptKind.APPROVAL
            ? GoalRunPhase.EXECUTING
            : GoalRunPhase.EXECUTING;

      const phaseUpdated = await tx.goalRun.updateMany({
        where: {
          id: prompt.goalRunId,
          phase: {
            in: [GoalRunPhase.WAITING_USER_INPUT, GoalRunPhase.WAITING_APPROVAL],
          },
        },
        data: {
          phase: nextPhase,
        },
      });

      // Outbox: emit once per prompt resolution
      const outboxDedupeKey = `user_prompt.resolved:${promptId}`;
      try {
        await tx.outbox.create({
          data: {
            id: createId(),
            dedupeKey: outboxDedupeKey,
            aggregateId: prompt.goalRunId,
            eventType: 'user_prompt.resolved',
            payload: {
              promptId,
              goalRunId: prompt.goalRunId,
              tenantId: goalRun.tenantId,
              checklistItemId: prompt.checklistItemId ?? null,
              goalSpecId: prompt.goalSpecId ?? null,
              kind: updatedPrompt.kind,
              stepDescription: checklistItemDescription,
              resolvedAt: resolvedAt.toISOString(),
            },
          },
        });
      } catch (error: any) {
        // Idempotent: ignore duplicate outbox emission
        if (error?.code !== 'P2002') {
          throw error;
        }
      }

      // Outbox: resume pipeline (DB commit -> outbox -> resumer -> Temporal Update)
      const resumeDedupeKey = `user_prompt.resume:${promptId}`;
      try {
        await tx.outbox.create({
          data: {
            id: createId(),
            dedupeKey: resumeDedupeKey,
            aggregateId: prompt.goalRunId,
            eventType: 'user_prompt.resume',
            payload: {
              promptId,
              goalRunId: prompt.goalRunId,
              tenantId: goalRun.tenantId,
              updateId: resumeDedupeKey,
            },
          },
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') {
          throw error;
        }
      }

      return {
        prompt: updatedPrompt,
        didResolve: true,
        phaseChanged: phaseUpdated.count > 0,
        previousPhase: goalRun.phase,
        nextPhase,
      };
    });

    if (result.didResolve && result.phaseChanged) {
      this.eventEmitter.emit('goal-run.phase-changed', {
        goalRunId: result.prompt.goalRunId,
        previousPhase: result.previousPhase,
        newPhase: result.nextPhase,
      });
    }

    if (result.didResolve) {
      try {
        this.promptResolvedTotal.labels(request.actor.type, result.prompt.kind).inc();
        if ((result.prompt as any).goalSpecId || result.prompt.kind === UserPromptKind.GOAL_INTAKE) {
          this.goalIntakeCompletedTotal.inc();
        }
        this.resumeOutboxEnqueuedTotal.labels('resolution').inc();
      } catch (error: any) {
        this.logger.debug(`Failed to record prompt resolution counters: ${error.message}`);
      }

      if (this.auditService) {
        try {
          await this.auditService.log({
            eventType: AuditEventType.USER_PROMPT_RESOLVED,
            actor: {
              type:
                request.actor.type === ActorType.HUMAN
                  ? 'user'
                  : request.actor.type === ActorType.AGENT || request.actor.type === ActorType.PARENT_AGENT
                    ? 'agent'
                    : 'system',
              id: request.actor.id,
              email: request.actor.email,
              name: request.actor.name,
              ipAddress: request.ipAddress,
              userAgent: request.userAgent,
            },
            resource: {
              type: 'prompt',
              id: request.promptId,
            },
            context: {
              tenantId: request.tenantId,
              workflowRunId: result.prompt.goalRunId,
              requestId: request.requestId,
            },
            action: {
              type: 'resolve',
              previousState: UserPromptStatus.OPEN,
              newState: UserPromptStatus.RESOLVED,
            },
            metadata: {
              goalRunId: result.prompt.goalRunId,
              checklistItemId: result.prompt.checklistItemId ?? null,
              goalSpecId: (result.prompt as any).goalSpecId ?? null,
              kind: result.prompt.kind,
            },
          });
        } catch (error: any) {
          this.logger.warn(`Failed to write audit log for prompt resolution: ${error.message}`);
        }
      }

      try {
        const durationSeconds = (resolvedAt.getTime() - result.prompt.createdAt.getTime()) / 1000;
        this.userPromptTimeToResolveSeconds.labels(result.prompt.kind).observe(durationSeconds);
      } catch (error: any) {
        this.logger.debug(`Failed to record prompt resolution metric: ${error.message}`);
      }
    }

    return {
      promptId: result.prompt.id,
      goalRunId: result.prompt.goalRunId,
      checklistItemId: result.prompt.checklistItemId ?? null,
      goalSpecId: (result.prompt as any).goalSpecId ?? null,
      didResolve: result.didResolve,
      promptStatus: result.prompt.status,
      promptKind: result.prompt.kind,
    };
  }
}
