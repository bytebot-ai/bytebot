import { Injectable, Logger } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from './prisma.service';
import {
  Prisma,
  UserPrompt,
  UserPromptCancelReason,
  UserPromptKind,
  UserPromptScope,
  UserPromptStatus,
} from '@prisma/client';

export interface EnsureOpenPromptForStepRequest {
  tenantId: string;
  goalRunId: string;
  checklistItemId: string;
  kind: UserPromptKind;
  payload: Prisma.InputJsonValue;
  expiresAt?: Date | null;
}

export interface EnsureOpenPromptForStepKeyRequest {
  tenantId: string;
  goalRunId: string;
  /**
   * Stable, engine-agnostic step key (e.g., "step-1") used when no ChecklistItem row exists
   * (e.g., TEMPORAL_WORKFLOW runs).
   */
  stepKey: string;
  kind: UserPromptKind;
  payload: Prisma.InputJsonValue;
  expiresAt?: Date | null;
}

export interface ListUserPromptsRequest {
  tenantId: string;
  goalRunId?: string;
  status?: UserPromptStatus;
  kind?: UserPromptKind;
  scope?: UserPromptScope;
  limit?: number;
}

@Injectable()
export class UserPromptService {
  private readonly logger = new Logger(UserPromptService.name);

  constructor(private readonly prisma: PrismaService) {}

  buildDedupeKey(goalRunId: string, checklistItemId: string, kind: UserPromptKind): string {
    return `prompt:${goalRunId}:${checklistItemId}:${kind}`;
  }

  buildGoalSpecDedupeKey(goalRunId: string, goalSpecId: string, kind: UserPromptKind): string {
    return `prompt:${goalRunId}:goalSpec:${goalSpecId}:${kind}`;
  }

  buildApprovalDedupeKey(goalRunId: string, approvalRequestId: string, kind: UserPromptKind): string {
    return `prompt:${goalRunId}:approval:${approvalRequestId}:${kind}`;
  }

  /**
   * Create (or return existing) OPEN prompt for a step.
   * Idempotent via unique UserPrompt.dedupeKey.
   */
  async ensureOpenPromptForStep(request: EnsureOpenPromptForStepRequest): Promise<UserPrompt> {
    const dedupeKey = this.buildDedupeKey(request.goalRunId, request.checklistItemId, request.kind);

    return this.ensureOpenPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      checklistItemId: request.checklistItemId,
      kind: request.kind,
      scope: UserPromptScope.STEP,
      payload: request.payload,
      dedupeKey,
      expiresAt: request.expiresAt ?? null,
    });
  }

  /**
   * Create (or return existing) OPEN prompt for an engine-native step key (Temporal).
   * This does not require a ChecklistItem row (avoids FK violations).
   */
  async ensureOpenPromptForStepKey(request: EnsureOpenPromptForStepKeyRequest): Promise<UserPrompt> {
    const dedupeKey = this.buildDedupeKey(request.goalRunId, request.stepKey, request.kind);

    return this.ensureOpenPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      kind: request.kind,
      scope: UserPromptScope.STEP,
      payload: request.payload,
      dedupeKey,
      expiresAt: request.expiresAt ?? null,
    });
  }

  /**
   * Create (or return existing) OPEN prompt for goal intake (GoalSpec gate).
   * Idempotent via unique UserPrompt.dedupeKey.
   */
  async ensureOpenGoalSpecPrompt(request: {
    tenantId: string;
    goalRunId: string;
    goalSpecId: string;
    kind: UserPromptKind;
    schemaId?: string | null;
    schemaVersion?: number | null;
    jsonSchema?: Prisma.InputJsonValue | null;
    uiSchema?: Prisma.InputJsonValue | null;
    validatorVersion?: string | null;
    payload: Prisma.InputJsonValue;
    expiresAt?: Date | null;
  }): Promise<UserPrompt> {
    const dedupeKey = this.buildGoalSpecDedupeKey(request.goalRunId, request.goalSpecId, request.kind);

    return this.ensureOpenPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      goalSpecId: request.goalSpecId,
      kind: request.kind,
      scope: UserPromptScope.RUN,
      schemaId: request.schemaId ?? null,
      schemaVersion: request.schemaVersion ?? null,
      jsonSchema: request.jsonSchema ?? null,
      uiSchema: request.uiSchema ?? null,
      validatorVersion: request.validatorVersion ?? null,
      payload: request.payload,
      dedupeKey,
      expiresAt: request.expiresAt ?? null,
    });
  }

  /**
   * Create (or return existing) OPEN prompt for an approval request.
   * Idempotent via unique UserPrompt.dedupeKey.
   */
  async ensureOpenApprovalPrompt(request: {
    tenantId: string;
    goalRunId: string;
    approvalRequestId: string;
    payload: Prisma.InputJsonValue;
    expiresAt?: Date | null;
  }): Promise<UserPrompt> {
    const dedupeKey = this.buildApprovalDedupeKey(request.goalRunId, request.approvalRequestId, UserPromptKind.APPROVAL);

    return this.ensureOpenPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      approvalRequestId: request.approvalRequestId,
      kind: UserPromptKind.APPROVAL,
      scope: UserPromptScope.APPROVAL,
      payload: request.payload,
      dedupeKey,
      expiresAt: request.expiresAt ?? null,
    });
  }

  async listUserPrompts(request: ListUserPromptsRequest): Promise<
    Array<
      Pick<
        UserPrompt,
        | 'id'
        | 'tenantId'
        | 'goalRunId'
        | 'checklistItemId'
        | 'goalSpecId'
        | 'approvalRequestId'
        | 'desktopLeaseId'
        | 'kind'
        | 'scope'
        | 'status'
        | 'dedupeKey'
        | 'schemaId'
        | 'schemaVersion'
        | 'uiSchema'
        | 'validatorVersion'
        | 'payload'
        | 'rootPromptId'
        | 'supersedesPromptId'
        | 'supersededByPromptId'
        | 'revision'
        | 'cancelReason'
        | 'cancelledAt'
        | 'expiresAt'
        | 'createdAt'
        | 'updatedAt'
        | 'resolvedAt'
      >
    >
  > {
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 200);

    return this.prisma.userPrompt.findMany({
      where: {
        tenantId: request.tenantId,
        ...(request.goalRunId ? { goalRunId: request.goalRunId } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...(request.kind ? { kind: request.kind } : {}),
        ...(request.scope ? { scope: request.scope } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        goalRunId: true,
        checklistItemId: true,
        goalSpecId: true,
        approvalRequestId: true,
        desktopLeaseId: true,
        kind: true,
        scope: true,
        status: true,
        dedupeKey: true,
        schemaId: true,
        schemaVersion: true,
        uiSchema: true,
        validatorVersion: true,
        payload: true,
        rootPromptId: true,
        supersedesPromptId: true,
        supersededByPromptId: true,
        revision: true,
        cancelReason: true,
        cancelledAt: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        resolvedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async ensureOpenPrompt(request: {
    tenantId: string;
    goalRunId: string;
    kind: UserPromptKind;
    dedupeKey: string;
    scope?: UserPromptScope;
    schemaId?: string | null;
    schemaVersion?: number | null;
    jsonSchema?: Prisma.InputJsonValue | null;
    uiSchema?: Prisma.InputJsonValue | null;
    validatorVersion?: string | null;
    payload: Prisma.InputJsonValue;
    checklistItemId?: string | null;
    goalSpecId?: string | null;
    approvalRequestId?: string | null;
    desktopLeaseId?: string | null;
    expiresAt?: Date | null;
  }): Promise<UserPrompt> {
    const maxAttempts = 3;
    const scope: UserPromptScope =
      request.scope ??
      (request.approvalRequestId
        ? UserPromptScope.APPROVAL
        : request.checklistItemId
          ? UserPromptScope.STEP
          : UserPromptScope.RUN);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const now = new Date();
      const newPromptId = createId();

      try {
        return await this.prisma.$transaction(async (tx) => {
          // Fast path: already created for this dedupeKey.
          const existingByDedupe = await tx.userPrompt.findUnique({ where: { dedupeKey: request.dedupeKey } });
          if (existingByDedupe) {
            return existingByDedupe;
          }

          // Enforce policy: at most one OPEN prompt per run.
          // If another OPEN prompt exists, cancel it as SUPERSEDED (no history overwrites).
          const existingOpen = await tx.userPrompt.findFirst({
            where: { goalRunId: request.goalRunId, status: UserPromptStatus.OPEN },
            orderBy: { createdAt: 'asc' },
          });

          if (existingOpen) {
            await tx.userPrompt.updateMany({
              where: { id: existingOpen.id, status: UserPromptStatus.OPEN },
              data: {
                status: UserPromptStatus.CANCELLED,
                cancelReason: UserPromptCancelReason.SUPERSEDED,
                cancelledAt: now,
                supersededByPromptId: newPromptId,
              },
            });
          }

          try {
            return await tx.userPrompt.create({
              data: {
                id: newPromptId,
                tenantId: request.tenantId,
                goalRunId: request.goalRunId,
                checklistItemId: request.checklistItemId ?? null,
                goalSpecId: request.goalSpecId ?? null,
                approvalRequestId: request.approvalRequestId ?? null,
                desktopLeaseId: request.desktopLeaseId ?? null,
                kind: request.kind,
                scope,
                status: UserPromptStatus.OPEN,
                dedupeKey: request.dedupeKey,
                schemaId: request.schemaId ?? null,
                schemaVersion: request.schemaVersion ?? null,
                jsonSchema: request.jsonSchema ?? Prisma.DbNull,
                uiSchema: request.uiSchema ?? Prisma.DbNull,
                validatorVersion: request.validatorVersion ?? null,
                payload: request.payload,
                expiresAt: request.expiresAt ?? null,
                supersedesPromptId: existingOpen?.id ?? null,
                rootPromptId: existingOpen ? (existingOpen.rootPromptId ?? existingOpen.id) : null,
                revision: existingOpen ? (existingOpen.revision + 1) : 1,
              },
            });
          } catch (error: any) {
            // P2002 is Prisma's unique constraint violation (dedupe key, or one-open-per-run index).
            if (error?.code !== 'P2002') {
              throw error;
            }

            const existing = await tx.userPrompt.findUnique({ where: { dedupeKey: request.dedupeKey } });
            if (existing) return existing;

            const openForRun = await tx.userPrompt.findFirst({
              where: { goalRunId: request.goalRunId, status: UserPromptStatus.OPEN },
              orderBy: { createdAt: 'desc' },
            });
            if (openForRun) return openForRun;

            throw error;
          }
        });
      } catch (error: any) {
        if (error?.code !== 'P2002' || attempt === maxAttempts) {
          throw error;
        }

        this.logger.warn(
          `UserPrompt create race (attempt ${attempt}/${maxAttempts}) for goalRunId=${request.goalRunId} dedupeKey=${request.dedupeKey}; retrying`,
        );
      }
    }

    // Unreachable
    throw new Error('Unexpected prompt create retry exhaustion');
  }
}
