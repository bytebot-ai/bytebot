/**
 * GoalRunWorkflow E2E Tests
 *
 * Tests the complete workflow lifecycle using Temporal's test environment.
 * Uses @temporalio/testing for deterministic time control and activity mocking.
 */

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { v4 as uuid } from 'uuid';

import { goalRunWorkflow } from '../../src/workflows/goal-run.workflow';
import type { GoalRunInput, GoalRunResult, Step } from '../../src/types/goal-run.types';

// Mock activities
const mockPlanGoal = jest.fn();
const mockExecuteStep = jest.fn();
const mockVerifyStep = jest.fn();
const mockEmitGoalEvent = jest.fn();
const mockEmitStepEvent = jest.fn();

describe('GoalRunWorkflow E2E Tests', () => {
  let testEnv: TestWorkflowEnvironment;
  let worker: Worker;
  let client: Client;

  beforeAll(async () => {
    // Reduce Temporal SDK logging noise in tests
    Runtime.install({
      logger: new DefaultLogger('WARN'),
    });

    // Create test environment
    testEnv = await TestWorkflowEnvironment.createLocal();
    client = testEnv.client;
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // Default mock implementations
    mockPlanGoal.mockResolvedValue({
      steps: [
        { stepNumber: 1, description: 'Test step 1', expectedOutcome: 'Step 1 complete', isHighRisk: false, dependencies: [] },
        { stepNumber: 2, description: 'Test step 2', expectedOutcome: 'Step 2 complete', isHighRisk: false, dependencies: [1] },
      ],
      planSummary: 'Test plan with 2 steps',
      confidence: 0.9,
    });

    mockExecuteStep.mockResolvedValue({
      success: true,
      outcome: 'Step executed successfully',
      artifacts: [],
      knowledgeGained: ['Learned something new'],
      needsApproval: false,
    });

    mockVerifyStep.mockResolvedValue({
      verified: true,
      verificationDetails: 'Step verified successfully',
      suggestReplan: false,
    });

    mockEmitGoalEvent.mockResolvedValue(undefined);
    mockEmitStepEvent.mockResolvedValue(undefined);
  });

  async function createWorker(): Promise<Worker> {
    return Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-goal-runs',
      workflowsPath: require.resolve('../../src/workflows/goal-run.workflow'),
      activities: {
        planGoal: mockPlanGoal,
        refinePlan: jest.fn(),
        executeStep: mockExecuteStep,
        verifyStep: mockVerifyStep,
        classifyFailure: jest.fn(),
        emitGoalEvent: mockEmitGoalEvent,
        emitStepEvent: mockEmitStepEvent,
      },
    });
  }

  function createTestInput(overrides?: Partial<GoalRunInput>): GoalRunInput {
    return {
      goalRunId: uuid(),
      tenantId: 'test-tenant',
      userId: 'test-user',
      goalDescription: 'Test goal description',
      workspaceId: 'test-workspace',
      constraints: {
        maxSteps: 10,
        maxRetries: 3,
        maxReplans: 2,
        timeoutMs: 300000,
        requireApprovalForHighRisk: true,
      },
      ...overrides,
    };
  }

  describe('Basic Workflow Execution', () => {
    it('should complete a simple 2-step workflow successfully', async () => {
      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-${input.goalRunId}`,
        });

        return handle.result();
      });

      expect(result.status).toBe('COMPLETED');
      expect(result.stepsCompleted).toBe(2);
      expect(mockPlanGoal).toHaveBeenCalledTimes(1);
      expect(mockExecuteStep).toHaveBeenCalledTimes(2);
      expect(mockVerifyStep).toHaveBeenCalledTimes(2);
      expect(mockEmitGoalEvent).toHaveBeenCalled();
    });

    it('should emit correct Kafka events during workflow execution', async () => {
      const worker = await createWorker();
      const input = createTestInput();

      await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-${input.goalRunId}`,
        });

        return handle.result();
      });

      // Verify GOAL_STARTED event
      expect(mockEmitGoalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'GOAL_STARTED',
          goalRunId: input.goalRunId,
          tenantId: input.tenantId,
        })
      );

      // Verify GOAL_COMPLETED event
      expect(mockEmitGoalEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'GOAL_COMPLETED',
          goalRunId: input.goalRunId,
        })
      );

      // Verify STEP events
      expect(mockEmitStepEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'STEP_STARTED',
          stepNumber: 1,
        })
      );
    });
  });

  describe('Error Handling and Retries', () => {
    it('should retry failed steps up to maxRetries', async () => {
      mockExecuteStep
        .mockResolvedValueOnce({
          success: false,
          outcome: '',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
          error: 'Transient error',
        })
        .mockResolvedValueOnce({
          success: false,
          outcome: '',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
          error: 'Transient error again',
        })
        .mockResolvedValue({
          success: true,
          outcome: 'Finally succeeded',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
        });

      const worker = await createWorker();
      const input = createTestInput({ constraints: { maxSteps: 10, maxRetries: 3, maxReplans: 2, timeoutMs: 300000, requireApprovalForHighRisk: true } });

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-retry-${input.goalRunId}`,
        });

        return handle.result();
      });

      expect(result.status).toBe('COMPLETED');
      expect(mockExecuteStep.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('should trigger replanning when verification fails and suggests replan', async () => {
      mockVerifyStep
        .mockResolvedValueOnce({
          verified: false,
          verificationDetails: 'Step did not achieve expected outcome',
          suggestReplan: true,
          replanReason: 'Approach was incorrect',
        })
        .mockResolvedValue({
          verified: true,
          verificationDetails: 'Step verified successfully',
          suggestReplan: false,
        });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-replan-${input.goalRunId}`,
        });

        return handle.result();
      });

      // Should have called planGoal at least twice (initial + replan)
      expect(mockPlanGoal.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('should fail after exceeding maxReplans', async () => {
      mockVerifyStep.mockResolvedValue({
        verified: false,
        verificationDetails: 'Verification failed',
        suggestReplan: true,
        replanReason: 'Cannot complete step',
      });

      mockExecuteStep.mockResolvedValue({
        success: false,
        outcome: '',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        error: 'Persistent failure',
      });

      const worker = await createWorker();
      const input = createTestInput({
        constraints: { maxSteps: 10, maxRetries: 1, maxReplans: 1, timeoutMs: 300000, requireApprovalForHighRisk: true },
      });

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-maxreplan-${input.goalRunId}`,
        });

        return handle.result();
      });

      expect(result.status).toBe('FAILED');
      expect(result.errorDetails?.errorType).toContain('REPLAN');
    });
  });

  describe('Signal Handling', () => {
    it('should handle pause and resume signals', async () => {
      // Make execution slow enough to send signals
      mockExecuteStep.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          success: true,
          outcome: 'Step executed',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
        };
      });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-pause-${input.goalRunId}`,
        });

        // Send pause signal
        await handle.signal('pauseGoal');

        // Query progress to verify paused state
        const progress = await handle.query('getProgress') as { isPaused: boolean };
        expect(progress.isPaused).toBe(true);

        // Resume
        await handle.signal('resumeGoal');

        return handle.result();
      });

      expect(result.status).toBe('COMPLETED');
    });

    it('should handle cancel signal and terminate workflow', async () => {
      mockExecuteStep.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return {
          success: true,
          outcome: 'Step executed',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
        };
      });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-cancel-${input.goalRunId}`,
        });

        // Wait a bit then cancel
        await new Promise((resolve) => setTimeout(resolve, 50));
        await handle.signal('cancelGoal', { reason: 'User requested cancellation' });

        return handle.result();
      });

      expect(result.status).toBe('CANCELLED');
      expect(result.summary).toContain('cancelled');
    });
  });

  describe('Query Handling', () => {
    it('should return correct progress via getProgress query', async () => {
      let progressDuringExecution: { goalRunId: string; totalSteps: number } | null = null;

      mockExecuteStep.mockImplementation(async () => {
        return {
          success: true,
          outcome: 'Step executed',
          artifacts: [],
          knowledgeGained: [],
          needsApproval: false,
        };
      });

      const worker = await createWorker();
      const input = createTestInput();

      await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-query-${input.goalRunId}`,
        });

        // Query progress
        progressDuringExecution = await handle.query('getProgress') as { goalRunId: string; totalSteps: number };

        return handle.result();
      });

      expect(progressDuringExecution!.goalRunId).toBe(input.goalRunId);
      expect(progressDuringExecution!.totalSteps).toBeGreaterThan(0);
    });

    it('should return checkpoint data via getCheckpoint query', async () => {
      const worker = await createWorker();
      const input = createTestInput();

      await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-checkpoint-${input.goalRunId}`,
        });

        const checkpoint = await handle.query('getCheckpoint') as { goalRunId: string; progressSummary: string };
        expect(checkpoint.goalRunId).toBe(input.goalRunId);
        expect(checkpoint.progressSummary).toBeDefined();

        return handle.result();
      });
    });
  });

  describe('High-Risk Step Approval', () => {
    it('should wait for approval on high-risk steps', async () => {
      mockPlanGoal.mockResolvedValue({
        steps: [
          { stepNumber: 1, description: 'High risk step', expectedOutcome: 'Done', isHighRisk: true, dependencies: [] },
        ],
        planSummary: 'Plan with high-risk step',
        confidence: 0.9,
      });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-approval-${input.goalRunId}`,
        });

        // Wait for approval request
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check workflow is awaiting approval
        const progress = await handle.query('getProgress') as { isAwaitingApproval: boolean };
        expect(progress.isAwaitingApproval).toBe(true);

        // Approve the step
        await handle.signal('approveStep', { stepId: 'step-1', approver: 'test-user' });

        return handle.result();
      });

      expect(result.status).toBe('COMPLETED');
      expect(mockEmitStepEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'STEP_APPROVAL_REQUESTED',
        })
      );
    });

    it('should skip step when rejected', async () => {
      mockPlanGoal.mockResolvedValue({
        steps: [
          { stepNumber: 1, description: 'High risk step', expectedOutcome: 'Done', isHighRisk: true, dependencies: [] },
          { stepNumber: 2, description: 'Normal step', expectedOutcome: 'Done', isHighRisk: false, dependencies: [] },
        ],
        planSummary: 'Plan with high-risk step',
        confidence: 0.9,
      });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-reject-${input.goalRunId}`,
        });

        // Wait for approval request
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Reject the step
        await handle.signal('rejectStep', { stepId: 'step-1', reason: 'Too risky' });

        return handle.result();
      });

      expect(result.status).toBe('COMPLETED');
      expect(mockEmitStepEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'STEP_REJECTED',
        })
      );
    });
  });

  describe('Knowledge Accumulation', () => {
    it('should accumulate knowledge across steps', async () => {
      mockExecuteStep
        .mockResolvedValueOnce({
          success: true,
          outcome: 'Step 1 done',
          artifacts: [],
          knowledgeGained: ['Fact 1: Server is on port 8080'],
          needsApproval: false,
        })
        .mockResolvedValueOnce({
          success: true,
          outcome: 'Step 2 done',
          artifacts: [],
          knowledgeGained: ['Fact 2: Database connection successful'],
          needsApproval: false,
        });

      const worker = await createWorker();
      const input = createTestInput();

      const result = await worker.runUntil(async () => {
        const handle = await client.workflow.start(goalRunWorkflow, {
          args: [input],
          taskQueue: 'test-goal-runs',
          workflowId: `test-knowledge-${input.goalRunId}`,
        });

        return handle.result();
      });

      expect(result.knowledgeGained).toContain('Fact 1: Server is on port 8080');
      expect(result.knowledgeGained).toContain('Fact 2: Database connection successful');
    });
  });
});
