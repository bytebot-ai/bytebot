/**
 * Planning Activities Unit Tests
 *
 * Tests the planning activity functions with mocked external services.
 */

import axios from 'axios';
import { MockActivityEnvironment } from '@temporalio/testing';
import { planGoal, refinePlan } from './planning.activities';
import type { PlanGoalInput, PlanGoalOutput } from '../types/goal-run.types';

jest.mock('axios');
const mockedAxios = axios as unknown as jest.MockedFunction<typeof axios>;

describe('Planning Activities', () => {
  let mockActivityEnv: MockActivityEnvironment;

  beforeEach(() => {
    mockActivityEnv = new MockActivityEnvironment();
    jest.clearAllMocks();
  });

  describe('planGoal', () => {
    const defaultInput: PlanGoalInput = {
      goalRunId: 'test-goal-123',
      tenantId: 'test-tenant',
      goalDescription: 'Create a new API endpoint for user management',
      previousFailures: [],
      accumulatedKnowledge: [],
      constraints: { maxSteps: 10 },
    };

    it('should successfully plan a goal via orchestrator', async () => {
      const mockResponse = {
        data: {
          kind: 'PLAN',
          steps: [
            { stepNumber: 1, description: 'Design API schema', expectedOutcome: 'Schema defined', isHighRisk: false },
            { stepNumber: 2, description: 'Implement endpoint', expectedOutcome: 'Endpoint working', isHighRisk: false },
            { stepNumber: 3, description: 'Write tests', expectedOutcome: 'Tests passing', isHighRisk: false },
          ],
          planSummary: 'Create user management API in 3 steps',
          estimatedDurationMs: 300000,
          confidence: 0.85,
        },
      };

      mockedAxios.mockResolvedValueOnce(mockResponse as any);

      const result = await mockActivityEnv.run(planGoal, defaultInput) as PlanGoalOutput;

      expect(result.kind).toBe('PLAN');
      if (result.kind !== 'PLAN') throw new Error('Expected PLAN result');
      expect(result.steps).toHaveLength(3);
      expect(result.planSummary).toBe('Create user management API in 3 steps');
      expect(result.confidence).toBe(0.85);
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringContaining('/api/v1/internal/plan'),
          data: expect.objectContaining({
            goalRunId: defaultInput.goalRunId,
            tenantId: defaultInput.tenantId,
          }),
        }),
      );
    });

    it('should include previous failures in planning context', async () => {
      const inputWithFailures: PlanGoalInput = {
        ...defaultInput,
        previousFailures: [
          { stepNumber: 1, error: 'Permission denied when creating file' },
          { stepNumber: 2, error: 'Database connection timeout' },
        ],
      };

      const mockResponse = {
        data: {
          kind: 'PLAN',
          steps: [{ stepNumber: 1, description: 'Revised step', expectedOutcome: 'Done', isHighRisk: false }],
          planSummary: 'Revised plan',
          confidence: 0.7,
        },
      };

      mockedAxios.mockResolvedValueOnce(mockResponse as any);

      await mockActivityEnv.run(planGoal, inputWithFailures);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          data: expect.objectContaining({
            context: expect.stringContaining('Previous Attempts'),
          }),
        }),
      );
    });

    it('should fall back to LLM planning when orchestrator fails', async () => {
      // First call fails (orchestrator)
      mockedAxios
        .mockRejectedValueOnce(new Error('Orchestrator unavailable'))
        .mockResolvedValueOnce({
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    steps: [{ stepNumber: 1, description: 'Fallback step', expectedOutcome: 'Done', isHighRisk: false }],
                    planSummary: 'Fallback plan',
                    confidence: 0.6,
                  }),
                },
              },
            ],
          },
        });

      const result = await mockActivityEnv.run(planGoal, defaultInput) as PlanGoalOutput;

      expect(result.kind).toBe('PLAN');
      if (result.kind !== 'PLAN') throw new Error('Expected PLAN result');
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].description).toBe('Fallback step');
      expect(mockedAxios).toHaveBeenCalledTimes(2);
    });

    it('should return GOAL_INTAKE_REQUIRED when orchestrator blocks planning', async () => {
      mockedAxios.mockResolvedValueOnce({
        data: {
          kind: 'GOAL_INTAKE_REQUIRED',
          promptId: 'pr-1',
          goalSpecId: 'gs-1',
          reason: 'GOAL_SPEC_INCOMPLETE',
        },
      } as any);

      const result = await mockActivityEnv.run(planGoal, defaultInput) as PlanGoalOutput;

      expect(result.kind).toBe('GOAL_INTAKE_REQUIRED');
      if (result.kind !== 'GOAL_INTAKE_REQUIRED') throw new Error('Expected GOAL_INTAKE_REQUIRED result');
      expect(result.promptId).toBe('pr-1');
      expect(result.goalSpecId).toBe('gs-1');
      expect(result.reason).toBe('GOAL_SPEC_INCOMPLETE');
    });

    it('should normalize step numbers if not provided', async () => {
      const mockResponse = {
        data: {
          kind: 'PLAN',
          steps: [
            { description: 'Step without number', expectedOutcome: 'Done' },
            { description: 'Another step', expectedOutcome: 'Done' },
          ],
          planSummary: 'Plan',
        },
      };

      mockedAxios.mockResolvedValueOnce(mockResponse as any);

      const result = await mockActivityEnv.run(planGoal, defaultInput) as PlanGoalOutput;

      expect(result.kind).toBe('PLAN');
      if (result.kind !== 'PLAN') throw new Error('Expected PLAN result');
      expect(result.steps[0].stepNumber).toBe(1);
      expect(result.steps[1].stepNumber).toBe(2);
    });

    it('should heartbeat during planning', async () => {
      const heartbeatSpy = jest.fn();
      mockActivityEnv = new MockActivityEnvironment();
      mockActivityEnv.on('heartbeat', heartbeatSpy);

      const mockResponse = {
        data: {
          kind: 'PLAN',
          steps: [{ stepNumber: 1, description: 'Step', expectedOutcome: 'Done', isHighRisk: false }],
          planSummary: 'Plan',
        },
      };

      mockedAxios.mockResolvedValueOnce(mockResponse as any);

      await mockActivityEnv.run(planGoal, defaultInput);

      expect(heartbeatSpy).toHaveBeenCalled();
    });
  });

  describe('refinePlan', () => {
    it('should refine an existing plan based on feedback', async () => {
      const input = {
        currentPlan: [
          { stepNumber: 1, description: 'Original step', expectedOutcome: 'Done', isHighRisk: false, dependencies: [] },
        ],
        feedback: 'Step 1 is too vague, please be more specific',
        goalRunId: 'test-goal-123',
        tenantId: 'test-tenant',
      };

      const mockResponse = {
        data: {
          steps: [
            { stepNumber: 1, description: 'Refined specific step', expectedOutcome: 'Specific outcome', isHighRisk: false },
          ],
          planSummary: 'Refined plan',
          confidence: 0.8,
        },
      };

      mockedAxios.mockResolvedValueOnce(mockResponse as any);

      const result = await mockActivityEnv.run(refinePlan, input) as PlanGoalOutput;

      expect(result.kind).toBe('PLAN');
      if (result.kind !== 'PLAN') throw new Error('Expected PLAN result');
      expect(result.steps[0].description).toBe('Refined specific step');
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: expect.stringContaining('/api/v1/internal/refine-plan'),
          data: expect.objectContaining({
            currentPlan: input.currentPlan,
            feedback: input.feedback,
          }),
        }),
      );
    });

    it('should throw error when refinement fails', async () => {
      const input = {
        currentPlan: [],
        feedback: 'Improve plan',
      };

      mockedAxios.mockRejectedValueOnce(new Error('Service unavailable'));

      await expect(mockActivityEnv.run(refinePlan, input)).rejects.toThrow('Plan refinement failed');
    });
  });
});
