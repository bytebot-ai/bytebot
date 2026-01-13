import { GoalRunService } from './goal-run.service';
import { GoalRunExecutionEngine, GoalRunPhase, GoalRunStatus } from '@prisma/client';

describe('GoalRunService execution_engine (immutable per-run engine)', () => {
  it('sets executionEngine=LEGACY_DB_LOOP when Temporal is disabled', async () => {
    const prisma = {
      goalRun: {
        create: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const workflowService = {} as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const temporalWorkflowService = { isEnabled: jest.fn().mockReturnValue(false) } as any;
    const featureFlagService = { shouldUseTemporalWorkflow: jest.fn() } as any;

    prisma.goalRun.create.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      constraints: {},
      phase: GoalRunPhase.INITIALIZING,
      status: GoalRunStatus.PENDING,
      executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
      workflowRunId: null,
      currentPlanVersion: 0,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      completedAt: null,
    });

    const service = new GoalRunService(
      prisma,
      workflowService,
      eventEmitter,
      temporalWorkflowService,
      featureFlagService,
    );

    await service.createFromGoal({ tenantId: 't-1', goal: 'Do the thing', autoStart: false });

    expect(prisma.goalRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
        }),
      }),
    );
    expect(featureFlagService.shouldUseTemporalWorkflow).not.toHaveBeenCalled();
  });

  it('sets executionEngine=TEMPORAL_WORKFLOW when Temporal is enabled and feature flag routes it', async () => {
    const prisma = {
      goalRun: {
        create: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const workflowService = {} as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const temporalWorkflowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      getWorkflowId: jest.fn((goalRunId: string) => `goal-run-${goalRunId}`),
    } as any;
    const featureFlagService = {
      shouldUseTemporalWorkflow: jest.fn().mockReturnValue({ enabled: true, reason: 'test' }),
    } as any;

    prisma.goalRun.create.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      constraints: {},
      phase: GoalRunPhase.INITIALIZING,
      status: GoalRunStatus.PENDING,
      executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
      workflowRunId: null,
      currentPlanVersion: 0,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      completedAt: null,
    });

    const service = new GoalRunService(
      prisma,
      workflowService,
      eventEmitter,
      temporalWorkflowService,
      featureFlagService,
    );

    await service.createFromGoal({ tenantId: 't-1', goal: 'Do the thing', autoStart: false });

    expect(prisma.goalRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
          temporalWorkflowId: expect.stringMatching(/^goal-run-gr-/),
        }),
      }),
    );
    expect(featureFlagService.shouldUseTemporalWorkflow).toHaveBeenCalledTimes(1);
  });

  it('startGoalRun uses stored engine=LEGACY_DB_LOOP and does not re-route via feature flags', async () => {
    const prisma = {
      goalRun: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const workflowService = {} as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const temporalWorkflowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      startGoalRunWorkflow: jest.fn(),
    } as any;
    const featureFlagService = { shouldUseTemporalWorkflow: jest.fn() } as any;

    prisma.goalRun.findUnique.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
    });
    prisma.goalRun.update.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      constraints: {},
      phase: GoalRunPhase.INITIALIZING,
      status: GoalRunStatus.RUNNING,
      executionEngine: GoalRunExecutionEngine.LEGACY_DB_LOOP,
      workflowRunId: null,
      currentPlanVersion: 0,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });

    const service = new GoalRunService(
      prisma,
      workflowService,
      eventEmitter,
      temporalWorkflowService,
      featureFlagService,
    );

    await service.startGoalRun('gr-1');

    expect(featureFlagService.shouldUseTemporalWorkflow).not.toHaveBeenCalled();
    expect(temporalWorkflowService.startGoalRunWorkflow).not.toHaveBeenCalled();
    expect(eventEmitter.emit).toHaveBeenCalledWith('goal-run.started', { goalRunId: 'gr-1' });
  });

  it('startGoalRun uses stored engine=TEMPORAL_WORKFLOW and does not emit goal-run.started', async () => {
    const prisma = {
      goalRun: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      activityEvent: {
        create: jest.fn(),
      },
    } as any;

    const workflowService = {} as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const temporalWorkflowService = {
      isEnabled: jest.fn().mockReturnValue(true),
      startGoalRunWorkflow: jest.fn().mockResolvedValue({ workflowId: 'wf-1', runId: 'wr-1' }),
    } as any;
    const featureFlagService = { shouldUseTemporalWorkflow: jest.fn() } as any;

    prisma.goalRun.findUnique.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
    });
    prisma.goalRun.update.mockResolvedValueOnce({
      id: 'gr-1',
      tenantId: 't-1',
      goal: 'Do the thing',
      constraints: {},
      phase: GoalRunPhase.INITIALIZING,
      status: GoalRunStatus.RUNNING,
      executionEngine: GoalRunExecutionEngine.TEMPORAL_WORKFLOW,
      workflowRunId: null,
      currentPlanVersion: 0,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    });
    prisma.goalRun.updateMany.mockResolvedValueOnce({ count: 1 });

    const service = new GoalRunService(
      prisma,
      workflowService,
      eventEmitter,
      temporalWorkflowService,
      featureFlagService,
    );

    await service.startGoalRun('gr-1');

    expect(featureFlagService.shouldUseTemporalWorkflow).not.toHaveBeenCalled();
    expect(temporalWorkflowService.startGoalRunWorkflow).toHaveBeenCalledTimes(1);
    expect(prisma.goalRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'gr-1' }),
        data: expect.objectContaining({ temporalWorkflowId: 'wf-1', temporalRunId: 'wr-1' }),
      }),
    );
    expect(eventEmitter.emit).not.toHaveBeenCalledWith('goal-run.started', expect.anything());
  });
});
