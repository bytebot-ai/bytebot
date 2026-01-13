/**
 * Execution Activities Unit Tests
 *
 * Tests step execution, verification, and failure classification.
 */

import axios, { AxiosError } from 'axios';
import { MockActivityEnvironment } from '@temporalio/testing';
import { executeStep, verifyStep, classifyFailure } from './execution.activities';
import type { ExecuteStepInput, VerifyStepInput, ExecuteStepOutput, VerifyStepOutput } from '../types/goal-run.types';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Type for classifyFailure result
type FailureClassResult = {
  category: 'TRANSIENT' | 'SEMANTIC' | 'PERMANENT';
  retryable: boolean;
  suggestedAction: 'RETRY' | 'REPLAN' | 'FAIL';
};

describe('Execution Activities', () => {
  let mockActivityEnv: MockActivityEnvironment;

  beforeEach(() => {
    mockActivityEnv = new MockActivityEnvironment();
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('executeStep', () => {
    const defaultInput: ExecuteStepInput = {
      goalRunId: 'test-goal-123',
      tenantId: 'test-tenant',
      step: {
        stepNumber: 1,
        description: 'Create user API endpoint',
        expectedOutcome: 'API endpoint responds with 200',
        isHighRisk: false,
        dependencies: [],
      },
      workspaceId: 'test-workspace',
      context: {
        previousStepOutcome: undefined,
        accumulatedKnowledge: [],
      },
    };

    it('should successfully execute a step', async () => {
      jest.useRealTimers();

      // Mock task dispatch
      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, taskId: 'task-123', status: 'DISPATCHED' },
      });

      // Mock task completion polling
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'COMPLETED',
          output: {
            summary: 'API endpoint created successfully',
            result: 'Endpoint /api/users responds with 200',
            artifacts: ['/src/routes/users.ts'],
          },
        },
      });

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.success).toBe(true);
      expect(result.outcome).toContain('API endpoint created');
      expect(result.artifacts).toContain('/src/routes/users.ts');
    });

    it('should extract knowledge from execution output', async () => {
      jest.useRealTimers();

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, taskId: 'task-123', status: 'DISPATCHED' },
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'COMPLETED',
          output: {
            summary: 'Found that the server runs on port 3000. Discovered database uses PostgreSQL.',
            facts: ['Server port is 3000', 'Database is PostgreSQL'],
            discoveries: ['API uses REST pattern'],
          },
        },
      });

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.knowledgeGained).toContain('Server port is 3000');
      expect(result.knowledgeGained).toContain('Database is PostgreSQL');
      expect(result.knowledgeGained).toContain('API uses REST pattern');
    });

    it('should handle WAITING_USER_INPUT status', async () => {
      jest.useRealTimers();

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, taskId: 'task-123', status: 'DISPATCHED' },
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'WAITING_USER_INPUT',
          output: { summary: 'Requires clarification to proceed' },
        },
      });

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.success).toBe(false);
      expect(result.waitingForUserInput).toBe(true);
    });

    it('should handle failed task execution', async () => {
      jest.useRealTimers();

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, taskId: 'task-123', status: 'DISPATCHED' },
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: {
          status: 'FAILED',
          error: 'Permission denied: Cannot write to /etc/config',
        },
      });

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle connection refused errors', async () => {
      jest.useRealTimers();

      const error = new Error('ECONNREFUSED');
      (error as any).code = 'ECONNREFUSED';
      (mockedAxios.isAxiosError as unknown) = jest.fn().mockReturnValue(true);
      mockedAxios.post.mockRejectedValueOnce(error);

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain('service unavailable');
    });

    it('should handle rate limiting (429)', async () => {
      jest.useRealTimers();

      const error = {
        response: { status: 429 },
        message: 'Too Many Requests',
      };
      (mockedAxios.isAxiosError as unknown) = jest.fn().mockReturnValue(true);
      mockedAxios.post.mockRejectedValueOnce(error);

      const result = await mockActivityEnv.run(executeStep, defaultInput) as ExecuteStepOutput;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
    });

    it('should include idempotency key in task dispatch', async () => {
      jest.useRealTimers();

      mockedAxios.post.mockResolvedValueOnce({
        data: { success: true, taskId: 'task-123', status: 'DISPATCHED' },
      });

      mockedAxios.get.mockResolvedValueOnce({
        data: { status: 'COMPLETED', output: { summary: 'Done' } },
      });

      await mockActivityEnv.run(executeStep, defaultInput);

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          idempotencyKey: `${defaultInput.goalRunId}-step-${defaultInput.step.stepNumber}`,
        }),
        expect.any(Object)
      );
    });
  });

  describe('verifyStep', () => {
    const defaultInput: VerifyStepInput = {
      goalRunId: 'test-goal-123',
      tenantId: 'test-tenant',
      step: {
        stepNumber: 1,
        description: 'Create user API',
        expectedOutcome: 'API responds with 200',
        isHighRisk: false,
        dependencies: [],
      },
      executionResult: {
        success: true,
        outcome: 'API endpoint created',
        artifacts: [],
        knowledgeGained: [],
        needsApproval: false,
        waitingForUserInput: false,
      },
    };

    it('should verify successful step with expected outcome', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          verified: true,
          verificationDetails: 'API endpoint matches expected outcome',
          suggestReplan: false,
        },
      });

      const result = await mockActivityEnv.run(verifyStep, defaultInput) as VerifyStepOutput;

      expect(result.verified).toBe(true);
      expect(result.suggestReplan).toBe(false);
    });

    it('should suggest replan when verification fails', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          verified: false,
          verificationDetails: 'API returns 404 instead of 200',
          suggestReplan: true,
          replanReason: 'Route configuration incorrect',
        },
      });

      const result = await mockActivityEnv.run(verifyStep, defaultInput) as VerifyStepOutput;

      expect(result.verified).toBe(false);
      expect(result.suggestReplan).toBe(true);
      expect(result.replanReason).toBe('Route configuration incorrect');
    });

    it('should auto-verify when no expected outcome specified', async () => {
      const inputWithoutExpected: VerifyStepInput = {
        ...defaultInput,
        step: { ...defaultInput.step, expectedOutcome: undefined },
      };

      const result = await mockActivityEnv.run(verifyStep, inputWithoutExpected) as VerifyStepOutput;

      expect(result.verified).toBe(true);
      expect(result.verificationDetails).toContain('no expected outcome specified');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('should fallback to simple verification when orchestrator fails', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Service unavailable'));

      const result = await mockActivityEnv.run(verifyStep, defaultInput) as VerifyStepOutput;

      expect(result.verified).toBe(true); // Fallback based on success flag
      expect(result.verificationDetails).toContain('Fallback verification');
    });

    it('should fail verification for failed execution result', async () => {
      const failedInput: VerifyStepInput = {
        ...defaultInput,
        executionResult: {
          ...defaultInput.executionResult,
          success: false,
          error: 'Execution failed',
        },
      };

      mockedAxios.post.mockRejectedValueOnce(new Error('Service unavailable'));

      const result = await mockActivityEnv.run(verifyStep, failedInput) as VerifyStepOutput;

      expect(result.verified).toBe(false);
      expect(result.suggestReplan).toBe(true);
    });
  });

  describe('classifyFailure', () => {
    it('should classify timeout errors as TRANSIENT', async () => {
      const error = new Error('Request timeout after 30000ms');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('TRANSIENT');
      expect(result.retryable).toBe(true);
      expect(result.suggestedAction).toBe('RETRY');
    });

    it('should classify connection errors as TRANSIENT', async () => {
      const error = new Error('ECONNREFUSED: Connection refused to localhost:3000');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('TRANSIENT');
      expect(result.retryable).toBe(true);
    });

    it('should classify rate limit errors as TRANSIENT', async () => {
      const error = new Error('Rate limit exceeded, retry after 60 seconds');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('TRANSIENT');
    });

    it('should classify validation errors as SEMANTIC', async () => {
      const error = new Error('Validation error: Email format invalid');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('SEMANTIC');
      expect(result.retryable).toBe(false);
      expect(result.suggestedAction).toBe('REPLAN');
    });

    it('should classify step failures as SEMANTIC', async () => {
      const error = new Error('Step failed: Could not find expected file');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('SEMANTIC');
      expect(result.suggestedAction).toBe('REPLAN');
    });

    it('should classify permission errors as PERMANENT', async () => {
      const error = new Error('Permission denied: Cannot access resource');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('PERMANENT');
      expect(result.retryable).toBe(false);
      expect(result.suggestedAction).toBe('FAIL');
    });

    it('should classify resource deleted errors as PERMANENT', async () => {
      const error = new Error('Resource not found: Workspace deleted');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('PERMANENT');
      expect(result.suggestedAction).toBe('FAIL');
    });

    it('should default to SEMANTIC for unknown errors', async () => {
      const error = new Error('Some unexpected error occurred');

      const result = await mockActivityEnv.run(classifyFailure, error) as FailureClassResult;

      expect(result.category).toBe('SEMANTIC');
      expect(result.suggestedAction).toBe('REPLAN');
    });
  });
});
