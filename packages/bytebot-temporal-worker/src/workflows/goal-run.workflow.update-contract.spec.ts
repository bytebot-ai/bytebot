import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { temporal } from '@temporalio/proto';

import type { PlanGoalInput, PlanGoalOutput } from '../types/goal-run.types';

jest.setTimeout(60_000);

describe('GoalRunWorkflow Update contract', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();

    // GoalRunWorkflow upserts custom search attributes; register them so the test server accepts updates.
    try {
      await env.connection.operatorService.addSearchAttributes({
        namespace: env.namespace ?? 'default',
        searchAttributes: {
          ByteBotTenantId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
          ByteBotGoalRunId: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
          ByteBotPhase: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
          ByteBotStepCount: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_INT,
          ByteBotHasHighRiskSteps: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
          ByteBotIsAwaitingApproval: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_BOOL,
          ByteBotErrorType: temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
        },
      });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (!message.includes('ALREADY_EXISTS') && !message.toLowerCase().includes('already exists')) {
        throw error;
      }
    }
  });

  afterAll(async () => {
    await env.teardown();
  });

  it('registers and accepts the userPromptResolved Update (no "Update handler missing" regression)', async () => {
    const taskQueue = `tq-${Math.random().toString(16).slice(2)}`;

    let planCalls = 0;

    const activities = {
      planGoal: async (_input: PlanGoalInput): Promise<PlanGoalOutput> => {
        planCalls += 1;
        if (planCalls === 1) {
          return {
            kind: 'GOAL_INTAKE_REQUIRED',
            promptId: 'pr-1',
            goalSpecId: 'gs-1',
            reason: 'GOAL_SPEC_INCOMPLETE',
          };
        }
        return {
          kind: 'PLAN',
          steps: [
            {
              stepNumber: 1,
              description: 'Execute a simple step after goal intake',
              expectedOutcome: 'Step completes successfully',
              isHighRisk: false,
              dependencies: [],
              estimatedDurationMs: 1000,
            },
          ],
          planSummary: 'Single step plan',
          confidence: 0.9,
        };
      },
      executeStep: async () => ({
        success: true,
        outcome: 'ok',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        waitingForUserInput: false,
      }),
      verifyStep: async () => ({
        verified: true,
        verificationDetails: 'ok',
        suggestReplan: false,
      }),
      classifyFailure: async () => ({
        category: 'TRANSIENT' as const,
        retryable: true,
        suggestedAction: 'RETRY' as const,
      }),
      emitGoalEvent: async () => {},
      emitStepEvent: async () => {},
      emitAuditEvent: async () => {},
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./goal-run.workflow'),
      activities,
    });

    await worker.runUntil(async () => {
      const workflowId = `goal-run-${Math.random().toString(16).slice(2)}`;

      const handle = await env.client.workflow.start('goalRunWorkflow', {
        taskQueue,
        workflowId,
        args: [
          {
            goalRunId: 'gr-1',
            tenantId: 't-1',
            userId: 'u-1',
            goalDescription: 'Test goal intake before planning',
          },
        ],
      });

      // Let the workflow run its first planning attempt and enter WAITING_USER_INPUT.
      await env.sleep('1s');

      const progress = await handle.query<any>('getProgress');
      expect(progress.phase).toBe('WAITING_USER_INPUT');

      const updateResult = await (handle as any).executeUpdate('userPromptResolved', {
        args: [{ promptId: 'pr-1', answers: { notes: 'details' } }],
        updateId: 'user_prompt.resume:pr-1',
      });

      expect(updateResult).toEqual(expect.objectContaining({ accepted: true, applied: true }));

      const result = await handle.result();
      expect(result.status).toBe('COMPLETED');
      expect(planCalls).toBeGreaterThanOrEqual(2);
    });
  });

  it('supports CAPABILITY_PROBE mode without running activities (runtime probe safety)', async () => {
    const taskQueue = `tq-${Math.random().toString(16).slice(2)}`;

    const activities = {
      planGoal: jest.fn(async () => {
        throw new Error('planGoal must not be called in CAPABILITY_PROBE mode');
      }),
      executeStep: jest.fn(async () => {
        throw new Error('executeStep must not be called in CAPABILITY_PROBE mode');
      }),
      verifyStep: jest.fn(async () => {
        throw new Error('verifyStep must not be called in CAPABILITY_PROBE mode');
      }),
      classifyFailure: jest.fn(async () => ({
        category: 'TRANSIENT' as const,
        retryable: true,
        suggestedAction: 'RETRY' as const,
      })),
      emitGoalEvent: jest.fn(async () => {
        throw new Error('emitGoalEvent must not be called in CAPABILITY_PROBE mode');
      }),
      emitStepEvent: jest.fn(async () => {
        throw new Error('emitStepEvent must not be called in CAPABILITY_PROBE mode');
      }),
      emitAuditEvent: jest.fn(async () => {
        throw new Error('emitAuditEvent must not be called in CAPABILITY_PROBE mode');
      }),
    };

    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('./goal-run.workflow'),
      activities,
    });

    await worker.runUntil(async () => {
      const workflowId = `probe-${Math.random().toString(16).slice(2)}`;
      const handle = await env.client.workflow.start('goalRunWorkflow', {
        taskQueue,
        workflowId,
        workflowExecutionTimeout: '1m',
        args: [
          {
            goalRunId: workflowId,
            tenantId: 'system',
            userId: 'system',
            goalDescription: 'Temporal capability probe',
            mode: 'CAPABILITY_PROBE',
          },
        ],
      });

      await env.sleep('1s');

      const progress = await handle.query<any>('getProgress');
      expect(progress.phase).toBe('WAITING_USER_INPUT');

      const updateResult = await (handle as any).executeUpdate('userPromptResolved', {
        args: [{ promptId: workflowId, answers: { ok: true } }],
        updateId: `temporal_capability_probe:${workflowId}`,
      });
      expect(updateResult).toEqual(expect.objectContaining({ accepted: true, applied: true }));

      const result = await handle.result();
      expect(result.status).toBe('COMPLETED');
      expect(result.summary).toBe('CAPABILITY_PROBE_OK');

      expect(activities.planGoal).not.toHaveBeenCalled();
      expect(activities.emitGoalEvent).not.toHaveBeenCalled();
    });
  });
});
