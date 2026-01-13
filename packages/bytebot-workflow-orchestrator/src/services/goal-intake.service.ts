/**
 * Goal Intake Service (GoalSpec gate before planning)
 *
 * Converts "prompt-first" planner output into an External Input Request (EIR) that must
 * be satisfied before planning proceeds.
 *
 * Design:
 * - GoalSpec is the durable, typed intake state for a run.
 * - A GOAL_INTAKE UserPrompt is created exactly-once (dedupe) and the run enters WAITING_USER_INPUT.
 * - When the prompt is resolved, GoalSpec is marked COMPLETE and the run returns to INITIALIZING
 *   so planning can restart with the provided inputs.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createId } from '@paralleldrive/cuid2';
import { GoalRunPhase, GoalSpecStatus, UserPromptKind } from '@prisma/client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import { PrismaService } from './prisma.service';
import { UserPromptService } from './user-prompt.service';
import { OutboxService } from './outbox.service';
import { GoalRunService } from './goal-run.service';
import { PlannerFirstStepUserInputError } from './planner.errors';

@Injectable()
export class GoalIntakeService {
  private readonly logger = new Logger(GoalIntakeService.name);
  private cachedForceTenantsRaw = '';
  private cachedForceTenants = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly userPromptService: UserPromptService,
    private readonly outboxService: OutboxService,
    private readonly goalRunService: GoalRunService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    @InjectMetric('goal_intake_started_total')
    private readonly goalIntakeStartedTotal: Counter<string>,
  ) {}

  private getForcedTenants(): Set<string> {
    const raw = this.configService.get<string>('GOAL_INTAKE_FORCE_TENANTS', '');
    if (raw === this.cachedForceTenantsRaw) return this.cachedForceTenants;

    const parsed = new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

    this.cachedForceTenantsRaw = raw;
    this.cachedForceTenants = parsed;
    return parsed;
  }

  private shouldForceGoalIntakeForNewRun(tenantId: string): boolean {
    return this.getForcedTenants().has(tenantId);
  }

  private buildDefaultGoalSpecSchema(): {
    schemaId: string;
    schemaVersion: number;
    jsonSchema: Record<string, any>;
    uiSchema: Record<string, any>;
  } {
    const schemaId = 'goal_intake.v1';
    const schemaVersion = 1;
    const jsonSchema = {
      title: 'Goal Intake',
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          title: 'Required details',
          description: 'Provide any missing details needed to start this run (do not paste secrets).',
          minLength: 1,
        },
      },
      required: ['notes'],
      additionalProperties: true,
    } as const;

    const uiSchema = {
      notes: {
        'ui:widget': 'textarea',
        'ui:options': { rows: 6 },
      },
    } as const;

    return { schemaId, schemaVersion, jsonSchema: jsonSchema as any, uiSchema: uiSchema as any };
  }

  /**
   * Proactive GoalSpec gate before planning.
   *
   * Contract:
   * - If GoalSpec is INCOMPLETE, orchestrator MUST NOT proceed to PLANNING.
   * - Instead, ensure an OPEN GOAL_INTAKE prompt exists and the run is WAITING_USER_INPUT.
   * - If no GoalSpec exists yet, create a minimal COMPLETE GoalSpec (minimum viable spec).
   *
   * This makes "planner prompt-first output" a safety net, not the primary intake mechanism.
   */
  async ensureGoalSpecReadyForPlanning(request: {
    goalRunId: string;
    tenantId: string;
  }): Promise<
    | { ready: true; goalSpecId: string }
    | { ready: false; goalSpecId: string; promptId: string }
  > {
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: request.goalRunId },
      select: { id: true, tenantId: true, goal: true, phase: true },
    });
    if (!goalRun) throw new NotFoundException(`GoalRun ${request.goalRunId} not found`);

    const now = new Date();

    const existingGoalSpec = await this.prisma.goalSpec.findUnique({
      where: { goalRunId: request.goalRunId },
      select: {
        id: true,
        status: true,
        schemaId: true,
        schemaVersion: true,
        jsonSchema: true,
        uiSchema: true,
        values: true,
      },
    });

    const defaults = this.buildDefaultGoalSpecSchema();
    const initialStatus = this.shouldForceGoalIntakeForNewRun(goalRun.tenantId)
      ? GoalSpecStatus.INCOMPLETE
      : GoalSpecStatus.COMPLETE;

    const goalSpec =
      existingGoalSpec ??
      (await this.prisma.goalSpec.create({
        data: {
          id: createId(),
          goalRunId: request.goalRunId,
          tenantId: request.tenantId,
          status: initialStatus,
          schemaId: defaults.schemaId,
          schemaVersion: defaults.schemaVersion,
          jsonSchema: defaults.jsonSchema as any,
          uiSchema: defaults.uiSchema as any,
          values: {},
        },
        select: {
          id: true,
          status: true,
          schemaId: true,
          schemaVersion: true,
          jsonSchema: true,
          uiSchema: true,
          values: true,
        },
      }));

    if (goalSpec.status === GoalSpecStatus.COMPLETE) {
      return { ready: true, goalSpecId: goalSpec.id };
    }

    const prompt = await this.userPromptService.ensureOpenGoalSpecPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      goalSpecId: goalSpec.id,
      kind: UserPromptKind.GOAL_INTAKE,
      schemaId: goalSpec.schemaId ?? defaults.schemaId,
      schemaVersion: goalSpec.schemaVersion ?? defaults.schemaVersion,
      jsonSchema: (goalSpec.jsonSchema ?? defaults.jsonSchema) as any,
      uiSchema: (goalSpec.uiSchema ?? defaults.uiSchema) as any,
      validatorVersion: 'ajv@8',
      payload: {
        kind: 'GOAL_INTAKE',
        goalRunId: request.goalRunId,
        goal: goalRun.goal,
        reason: {
          code: 'GOAL_SPEC_INCOMPLETE',
          message: 'Goal intake is required before planning can begin',
        },
        question: 'Provide the required information to begin planning.',
        schemaId: goalSpec.schemaId ?? defaults.schemaId,
        schemaVersion: goalSpec.schemaVersion ?? defaults.schemaVersion,
        jsonSchema: goalSpec.jsonSchema ?? defaults.jsonSchema,
        uiSchema: goalSpec.uiSchema ?? defaults.uiSchema,
        existingValues: goalSpec.values ?? {},
      },
      // Default to 24h expiry; policy can be tightened later.
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    const phaseUpdated = await this.prisma.goalRun.updateMany({
      where: {
        id: request.goalRunId,
        phase: {
          in: [GoalRunPhase.INITIALIZING, GoalRunPhase.PLANNING, GoalRunPhase.EXECUTING, GoalRunPhase.REPLANNING],
        },
      },
      data: { phase: GoalRunPhase.WAITING_USER_INPUT },
    });

    if (phaseUpdated.count > 0) {
      this.goalIntakeStartedTotal.labels('gate').inc();

      this.eventEmitter.emit('goal-run.phase-changed', {
        goalRunId: request.goalRunId,
        previousPhase: goalRun.phase,
        newPhase: GoalRunPhase.WAITING_USER_INPUT,
      });

      await this.goalRunService.createActivityEvent(request.goalRunId, {
        eventType: 'USER_PROMPT_CREATED',
        title: 'Goal intake required (before planning)',
        description: 'Goal intake required before planning can begin',
        severity: 'warning',
        details: {
          promptId: prompt.id,
          promptKind: prompt.kind,
          dedupeKey: prompt.dedupeKey,
          goalSpecId: goalSpec.id,
        },
      });
    }

    await this.outboxService.enqueueOnce({
      dedupeKey: prompt.dedupeKey,
      aggregateId: request.goalRunId,
      eventType: 'user_prompt.created',
      payload: {
        promptId: prompt.id,
        goalRunId: request.goalRunId,
        tenantId: request.tenantId,
        checklistItemId: null,
        goalSpecId: goalSpec.id,
        kind: prompt.kind,
        stepDescription: 'Goal intake required before planning can begin',
      },
    });

    this.logger.warn(
      `Goal intake gate triggered for goalRunId=${request.goalRunId} promptId=${prompt.id} goalSpecId=${goalSpec.id}`,
    );

    return { ready: false, goalSpecId: goalSpec.id, promptId: prompt.id };
  }

  async requestGoalIntakeFromPlannerError(request: {
    goalRunId: string;
    tenantId: string;
    error: PlannerFirstStepUserInputError;
  }): Promise<{ goalSpecId: string; promptId: string }> {
    const goalRun = await this.prisma.goalRun.findUnique({
      where: { id: request.goalRunId },
      select: { id: true, tenantId: true, goal: true, phase: true },
    });
    if (!goalRun) throw new NotFoundException(`GoalRun ${request.goalRunId} not found`);

    const now = new Date();

    const { schemaId, schemaVersion, jsonSchema, uiSchema } = this.buildDefaultGoalSpecSchema();

    const goalSpec = await this.prisma.goalSpec.upsert({
      where: { goalRunId: request.goalRunId },
      create: {
        id: createId(),
        goalRunId: request.goalRunId,
        tenantId: request.tenantId,
        status: GoalSpecStatus.INCOMPLETE,
        schemaId,
        schemaVersion,
        jsonSchema: jsonSchema as any,
        uiSchema: uiSchema as any,
        values: {},
      },
      update: {
        status: GoalSpecStatus.INCOMPLETE,
        schemaId,
        schemaVersion,
        jsonSchema: jsonSchema as any,
        uiSchema: uiSchema as any,
      },
      select: { id: true, values: true },
    });

    const question = request.error.firstStep.description;
    const prompt = await this.userPromptService.ensureOpenGoalSpecPrompt({
      tenantId: request.tenantId,
      goalRunId: request.goalRunId,
      goalSpecId: goalSpec.id,
      kind: UserPromptKind.GOAL_INTAKE,
      schemaId,
      schemaVersion,
      jsonSchema: jsonSchema as any,
      uiSchema: uiSchema as any,
      validatorVersion: 'ajv@8',
      payload: {
        kind: 'GOAL_INTAKE',
        goalRunId: request.goalRunId,
        goal: goalRun.goal,
        reason: {
          code: request.error.reason,
          message: 'Planner required external input before planning could begin',
        },
        question,
        schemaId,
        schemaVersion,
        jsonSchema,
        uiSchema,
        existingValues: goalSpec.values,
      },
      // Default to 24h expiry; policy can be tightened later.
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });

    const phaseUpdated = await this.prisma.goalRun.updateMany({
      where: {
        id: request.goalRunId,
        phase: {
          in: [GoalRunPhase.INITIALIZING, GoalRunPhase.PLANNING, GoalRunPhase.EXECUTING, GoalRunPhase.REPLANNING],
        },
      },
      data: { phase: GoalRunPhase.WAITING_USER_INPUT },
    });

    if (phaseUpdated.count > 0) {
      this.goalIntakeStartedTotal.labels('planner_error').inc();

      this.eventEmitter.emit('goal-run.phase-changed', {
        goalRunId: request.goalRunId,
        previousPhase: goalRun.phase,
        newPhase: GoalRunPhase.WAITING_USER_INPUT,
      });

      await this.goalRunService.createActivityEvent(request.goalRunId, {
        eventType: 'USER_PROMPT_CREATED',
        title: 'Goal intake required (before planning)',
        description: question,
        severity: 'warning',
        details: {
          promptId: prompt.id,
          promptKind: prompt.kind,
          dedupeKey: prompt.dedupeKey,
          goalSpecId: goalSpec.id,
        },
      });
    }

    await this.outboxService.enqueueOnce({
      dedupeKey: prompt.dedupeKey,
      aggregateId: request.goalRunId,
      eventType: 'user_prompt.created',
      payload: {
        promptId: prompt.id,
        goalRunId: request.goalRunId,
        tenantId: request.tenantId,
        checklistItemId: null,
        goalSpecId: goalSpec.id,
        kind: prompt.kind,
        stepDescription: question,
      },
    });

    this.logger.warn(
      `Goal intake requested for goalRunId=${request.goalRunId} promptId=${prompt.id} goalSpecId=${goalSpec.id}`,
    );

    return { goalSpecId: goalSpec.id, promptId: prompt.id };
  }
}
