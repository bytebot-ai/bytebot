import { GoalRunService } from './goal-run.service';
import { GoalRunStatus, UserPromptCancelReason, UserPromptStatus } from '@prisma/client';

describe(GoalRunService.name, () => {
  describe('prompt cleanup on terminal goal run states', () => {
    it('cancels OPEN prompts when a goal run is cancelled', async () => {
      const prisma = {
        $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
        goalRun: {
          update: jest.fn(async () => ({ id: 'gr-1', status: GoalRunStatus.CANCELLED, workflowRunId: null })),
        },
        userPrompt: {
          updateMany: jest.fn(async () => ({ count: 2 })),
        },
      } as any;

      const service = new GoalRunService(
        prisma,
        { cancelWorkflow: jest.fn() } as any,
        { emit: jest.fn() } as any,
        undefined,
        undefined,
        undefined,
      );

      (service as any).createActivityEvent = jest.fn();

      await service.cancelGoalRun('gr-1', 'test cancel');

      expect(prisma.userPrompt.updateMany).toHaveBeenCalledWith({
        where: { goalRunId: 'gr-1', status: UserPromptStatus.OPEN },
        data: expect.objectContaining({
          status: UserPromptStatus.CANCELLED,
          cancelReason: UserPromptCancelReason.RUN_ENDED,
          cancelledAt: expect.any(Date),
        }),
      });
    });

    it('cancels OPEN prompts when a goal run fails', async () => {
      const prisma = {
        $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
        goalRun: {
          update: jest.fn(async () => ({ id: 'gr-1', status: GoalRunStatus.FAILED, workflowRunId: null })),
        },
        userPrompt: {
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      } as any;

      const service = new GoalRunService(
        prisma,
        { cancelWorkflow: jest.fn() } as any,
        { emit: jest.fn() } as any,
        undefined,
        undefined,
        undefined,
      );

      (service as any).createActivityEvent = jest.fn();

      await service.failGoalRun('gr-1', 'boom');

      expect(prisma.userPrompt.updateMany).toHaveBeenCalledWith({
        where: { goalRunId: 'gr-1', status: UserPromptStatus.OPEN },
        data: expect.objectContaining({
          status: UserPromptStatus.CANCELLED,
          cancelReason: UserPromptCancelReason.RUN_ENDED,
          cancelledAt: expect.any(Date),
        }),
      });
    });

    it('cancels OPEN prompts when a goal run completes', async () => {
      const prisma = {
        $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
        goalRun: {
          update: jest.fn(async () => ({ id: 'gr-1', status: GoalRunStatus.COMPLETED, workflowRunId: null })),
        },
        userPrompt: {
          updateMany: jest.fn(async () => ({ count: 3 })),
        },
      } as any;

      const service = new GoalRunService(
        prisma,
        { cancelWorkflow: jest.fn() } as any,
        { emit: jest.fn() } as any,
        undefined,
        undefined,
        undefined,
      );

      (service as any).createActivityEvent = jest.fn();

      await service.completeGoalRun('gr-1');

      expect(prisma.userPrompt.updateMany).toHaveBeenCalledWith({
        where: { goalRunId: 'gr-1', status: UserPromptStatus.OPEN },
        data: expect.objectContaining({
          status: UserPromptStatus.CANCELLED,
          cancelReason: UserPromptCancelReason.RUN_ENDED,
          cancelledAt: expect.any(Date),
        }),
      });
    });
  });
});

