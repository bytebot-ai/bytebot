import { InternalController } from './internal.controller';
import { ExecutionSurface, StepType } from '@prisma/client';

describe('InternalController planner/dispatch contract gates', () => {
  const makeController = (overrides?: Partial<{
    ensureGoalSpecReadyForPlanning: jest.Mock;
    requestGoalIntakeFromPlannerError: jest.Mock;
    prismaGoalRunFindUnique: jest.Mock;
    dispatchTask: jest.Mock;
  }>) => {
    const taskDispatchService = {
      dispatchTask: overrides?.dispatchTask ?? jest.fn(),
    } as any;

    const prismaService = {
      goalRun: {
        findUnique: overrides?.prismaGoalRunFindUnique ?? jest.fn(),
      },
    } as any;

    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;

    const goalIntakeService = {
      ensureGoalSpecReadyForPlanning:
        overrides?.ensureGoalSpecReadyForPlanning ??
        jest.fn().mockResolvedValue({ ready: true }),
      requestGoalIntakeFromPlannerError:
        overrides?.requestGoalIntakeFromPlannerError ??
        jest.fn().mockResolvedValue({ goalSpecId: 'gs_test', promptId: 'up_test' }),
    } as any;

    return new InternalController(taskDispatchService, prismaService, configService, goalIntakeService);
  };

  describe('POST /api/v1/internal/plan', () => {
    it('returns GOAL_INTAKE_REQUIRED when planner outputs suggestedTools=["CHAT"] (interaction alias)', async () => {
      const goalIntake = jest.fn().mockResolvedValue({ goalSpecId: 'gs1', promptId: 'p1' });
      const controller = makeController({ requestGoalIntakeFromPlannerError: goalIntake });

      jest.spyOn(controller as any, 'callLLM').mockResolvedValueOnce(
        JSON.stringify({
          planSummary: 'test',
          steps: [
            {
              stepNumber: 1,
              description: 'Ask the user to confirm the target URL',
              type: StepType.EXECUTE, // misclassified
              suggestedTools: ['CHAT'],
              requiresDesktop: false,
              expectedOutcome: 'URL confirmed',
              isHighRisk: false,
              dependencies: [],
            },
          ],
          confidence: 0.9,
        }),
      );

      const result = await controller.generatePlan(
        {
          goalRunId: 'gr1',
          tenantId: 't1',
          goalDescription: 'Test goal',
          constraints: { maxSteps: 3 },
        } as any,
        'true',
      );

      expect(result).toEqual({
        kind: 'GOAL_INTAKE_REQUIRED',
        goalSpecId: 'gs1',
        promptId: 'p1',
        reason: 'ASK_USER_TOOL',
      });
      expect(goalIntake).toHaveBeenCalledTimes(1);
    });

    it('retries on unknown suggestedTools tokens and succeeds when a later attempt is valid', async () => {
      const controller = makeController();
      const llm = jest.spyOn(controller as any, 'callLLM');

      llm
        .mockResolvedValueOnce(
          JSON.stringify({
            planSummary: 'bad tools',
            steps: [
              {
                stepNumber: 1,
                description: 'Do the thing',
                type: StepType.EXECUTE,
                suggestedTools: ['totally_not_a_real_tool'],
                requiresDesktop: true,
                expectedOutcome: 'Done',
                isHighRisk: false,
                dependencies: [],
              },
            ],
            confidence: 0.9,
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            planSummary: 'good tools',
            steps: [
              {
                stepNumber: 1,
                description: 'Open the target site in the browser',
                type: StepType.EXECUTE,
                suggestedTools: [],
                requiresDesktop: true,
                expectedOutcome: 'Site is open',
                isHighRisk: false,
                dependencies: [],
              },
            ],
            confidence: 0.9,
          }),
        );

      const result = await controller.generatePlan(
        {
          goalRunId: 'gr1',
          tenantId: 't1',
          goalDescription: 'Test goal',
          constraints: { maxSteps: 3 },
        } as any,
        'true',
      );

      expect(result.kind).toBe('PLAN');
      expect(llm).toHaveBeenCalledTimes(2);
    });
  });

  describe('POST /api/v1/internal/dispatch-step', () => {
    it('defaults to DESKTOP when workspaceId is present and surface fields are omitted', async () => {
      const dispatchTask = jest.fn().mockResolvedValue({ success: true, taskId: 'task1' });
      const prismaGoalRunFindUnique = jest.fn().mockResolvedValue({ goal: 'Do the thing' });
      const controller = makeController({ dispatchTask, prismaGoalRunFindUnique });

      const result = await controller.dispatchStep(
        {
          goalRunId: 'gr1',
          tenantId: 't1',
          workspaceId: 'ws1',
          idempotencyKey: 'gr1-step-1',
          step: {
            stepNumber: 1,
            description: 'Open the website',
          },
        } as any,
        'true',
      );

      expect(result).toEqual({ success: true, taskId: 'task1', status: 'DISPATCHED' });
      expect(dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresDesktop: true,
          executionSurface: ExecutionSurface.DESKTOP,
          allowedTools: [],
        }),
      );
    });

    it('rejects dispatch-step when suggestedTools contains unknown tokens (fail-closed)', async () => {
      const dispatchTask = jest.fn();
      const prismaGoalRunFindUnique = jest.fn().mockResolvedValue({ goal: 'Do the thing' });
      const controller = makeController({ dispatchTask, prismaGoalRunFindUnique });

      const result = await controller.dispatchStep(
        {
          goalRunId: 'gr1',
          tenantId: 't1',
          workspaceId: 'ws1',
          idempotencyKey: 'gr1-step-1',
          step: {
            stepNumber: 1,
            description: 'Open the website',
            suggestedTools: ['not_a_real_tool_token'],
          },
        } as any,
        'true',
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/unknown suggestedTools token/i);
      expect(dispatchTask).not.toHaveBeenCalled();
    });
  });
});

