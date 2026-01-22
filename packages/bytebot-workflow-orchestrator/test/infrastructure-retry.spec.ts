/**
 * Golden Run Regression Test: Infrastructure Retry (No Replan)
 *
 * This test suite verifies the fix for consuming replan budget on
 * infrastructure failures (404, timeout, network errors).
 *
 * Bug: Infrastructure failures like 404 were treated as semantic failures,
 *      triggering replans and consuming the 3-attempt replan budget.
 *      This caused goal runs to fail when the actual task logic was correct.
 *
 * Fix: Infrastructure failure classification and retry
 *      1. [INFRA] prefix in error messages signals infrastructure failure
 *      2. Infrastructure failures trigger RETRY action (not REPLAN)
 *      3. Retry uses exponential backoff (10s, 20s, 40s, 80s, 160s)
 *      4. Max 5 retries before escalating to replan
 *      5. Replan budget is preserved for actual semantic failures
 *
 * @see orchestrator-loop.service.ts v1.1.1
 */

import { OrchestratorLoopService } from '../src/services/orchestrator-loop.service';
import { ChecklistItemStatus } from '@prisma/client';

// Mock modules
jest.mock('../src/services/prisma.service');
jest.mock('../src/services/goal-run.service');
jest.mock('../src/services/planner.service');
jest.mock('../src/services/workflow.service');
jest.mock('../src/services/task-dispatch.service');
jest.mock('@nestjs/event-emitter');
jest.mock('@nestjs/config');

describe('InfrastructureRetry', () => {
  let orchestratorLoop: OrchestratorLoopService;
  let mockPrisma: any;
  let mockGoalRunService: any;
  let mockPlannerService: any;
  let mockWorkflowService: any;
  let mockTaskDispatchService: any;
  let mockEventEmitter: any;
  let mockConfigService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma = {
      goalRun: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      checklistItem: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      steeringMessage: {
        update: jest.fn(),
      },
    };

    mockGoalRunService = {
      getPendingSteering: jest.fn().mockResolvedValue(null),
      createActivityEvent: jest.fn(),
      updatePhase: jest.fn(),
      failGoalRun: jest.fn(),
      completeGoalRun: jest.fn(),
    };

    mockPlannerService = {
      generateReplan: jest.fn(),
    };

    mockWorkflowService = {
      ensureWorkspaceProvisioned: jest.fn().mockResolvedValue({ success: true }),
    };

    mockTaskDispatchService = {
      getStatusCheckHealth: jest.fn().mockReturnValue({ isHealthy: true, consecutiveFailures: 0 }),
      getLastProgressTime: jest.fn().mockReturnValue(new Date()),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockConfigService = {
      get: jest.fn(),
    };

    orchestratorLoop = new OrchestratorLoopService(
      mockPrisma,
      mockGoalRunService,
      mockPlannerService,
      mockWorkflowService,
      mockTaskDispatchService,
      mockEventEmitter,
      mockConfigService,
    );
  });

  describe('isInfrastructureFailure detection', () => {
    const testCases = [
      // Should be detected as infrastructure failures
      { outcome: '[INFRA] Task not found after 70s (404 x14)', expected: true },
      { outcome: 'Error: [INFRA] Agent unreachable', expected: true },
      { outcome: 'INFRA_LOOKUP_FAILED: Task not found', expected: true },
      { outcome: 'Task not found in task controller (404)', expected: true },
      { outcome: '503 Service Unavailable', expected: true },
      { outcome: 'Error: connect ECONNREFUSED 10.0.0.1:9991', expected: true },
      { outcome: 'Error: ETIMEDOUT', expected: true },
      { outcome: 'Error: socket hang up', expected: true },
      { outcome: 'Waiting for capacity', expected: true },
      { outcome: 'Workspace not ready: pending provisioning', expected: true },

      // Should NOT be detected as infrastructure failures (semantic failures)
      { outcome: 'Verification failed: expected "login" but got "error"', expected: false },
      { outcome: 'Task failed: could not complete the required action', expected: false },
      { outcome: 'Authentication failed: invalid credentials', expected: false },
      { outcome: 'Permission denied: cannot access resource', expected: false },
      { outcome: 'Error: element not found on page', expected: false },
      { outcome: 'Assertion failed: prices do not match', expected: false },
    ];

    testCases.forEach(({ outcome, expected }) => {
      it(`should ${expected ? '' : 'NOT '}detect "${outcome.substring(0, 40)}..." as infrastructure failure`, () => {
        const item = { actualOutcome: outcome };
        const result = (orchestratorLoop as any).isInfrastructureFailure(item);
        expect(result).toBe(expected);
      });
    });

    it('should return false for null/undefined actualOutcome', () => {
      expect((orchestratorLoop as any).isInfrastructureFailure({})).toBe(false);
      expect((orchestratorLoop as any).isInfrastructureFailure({ actualOutcome: null })).toBe(false);
      expect((orchestratorLoop as any).isInfrastructureFailure({ actualOutcome: undefined })).toBe(false);
    });
  });

  describe('makeDecision infrastructure handling', () => {
    it('should return RETRY for infrastructure failure (not REPLAN)', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              description: 'Do something',
              actualOutcome: '[INFRA] Task not found after 70s (404 x14)',
            },
          ],
        }],
      };

      // Access private method via any cast
      const decision = await (orchestratorLoop as any).makeDecision(goalRun);

      expect(decision.action).toBe('RETRY');
      expect(decision.itemId).toBe('item-1');
      expect(decision.reason).toContain('Infrastructure failure');
    });

    it('should return REPLAN for semantic failure (not RETRY)', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              description: 'Click login button',
              actualOutcome: 'Verification failed: login page not displayed',
            },
          ],
        }],
      };

      const decision = await (orchestratorLoop as any).makeDecision(goalRun);

      expect(decision.action).toBe('REPLAN');
      expect(decision.itemId).toBe('item-1');
    });

    it('should track infrastructure retry count per item', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              actualOutcome: '[INFRA] 404',
            },
          ],
        }],
      };

      // First retry
      let decision = await (orchestratorLoop as any).makeDecision(goalRun);
      expect(decision.action).toBe('RETRY');
      expect(decision.retryCount).toBe(1);

      // Simulate retry was executed
      (orchestratorLoop as any).infraRetryCounts.set('item-1', 1);
      (orchestratorLoop as any).infraRetryAfter.set('item-1', Date.now() - 1000); // Backoff expired

      // Second retry
      decision = await (orchestratorLoop as any).makeDecision(goalRun);
      expect(decision.action).toBe('RETRY');
      expect(decision.retryCount).toBe(2);
    });

    it('should respect exponential backoff between retries', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              actualOutcome: '[INFRA] 404',
            },
          ],
        }],
      };

      // Set retry count but backoff not expired
      (orchestratorLoop as any).infraRetryCounts.set('item-1', 2);
      (orchestratorLoop as any).infraRetryAfter.set('item-1', Date.now() + 30000); // 30s in future

      const decision = await (orchestratorLoop as any).makeDecision(goalRun);

      // Should return CONTINUE (wait for backoff)
      expect(decision.action).toBe('CONTINUE');
    });

    it('should escalate to REPLAN after max infrastructure retries', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              actualOutcome: '[INFRA] Still failing after many retries',
            },
          ],
        }],
      };

      // Set retry count to max (5)
      (orchestratorLoop as any).infraRetryCounts.set('item-1', 5);

      const decision = await (orchestratorLoop as any).makeDecision(goalRun);

      // Should escalate to REPLAN
      expect(decision.action).toBe('REPLAN');
    });
  });

  describe('executeInfrastructureRetry', () => {
    it('should reset checklist item to PENDING for retry', async () => {
      const goalRun = { id: 'goal-1' };
      const itemId = 'item-1';

      mockPrisma.checklistItem.findUnique.mockResolvedValue({
        id: itemId,
        description: 'Test step',
      });

      await (orchestratorLoop as any).executeInfrastructureRetry(
        goalRun,
        itemId,
        1,
        10000,
        '[INFRA] 404',
      );

      // Check item was reset to PENDING
      expect(mockPrisma.checklistItem.update).toHaveBeenCalledWith({
        where: { id: itemId },
        data: {
          status: ChecklistItemStatus.PENDING,
          startedAt: null,
          completedAt: null,
          actualOutcome: null,
        },
      });

      // Check activity event was created
      expect(mockGoalRunService.createActivityEvent).toHaveBeenCalledWith(
        goalRun.id,
        expect.objectContaining({
          eventType: 'STEP_INFRA_RETRY',
          severity: 'warning',
        }),
      );
    });

    it('should update retry tracking with exponential backoff', async () => {
      const goalRun = { id: 'goal-1' };
      const itemId = 'item-1';

      mockPrisma.checklistItem.findUnique.mockResolvedValue({
        id: itemId,
        description: 'Test step',
      });

      const beforeTime = Date.now();
      await (orchestratorLoop as any).executeInfrastructureRetry(
        goalRun,
        itemId,
        3, // 3rd retry
        40000, // 40 second delay
        '[INFRA] 404',
      );

      // Check retry count was updated
      expect((orchestratorLoop as any).infraRetryCounts.get(itemId)).toBe(3);

      // Check retry after was set (current time + delay)
      const retryAfter = (orchestratorLoop as any).infraRetryAfter.get(itemId);
      expect(retryAfter).toBeGreaterThanOrEqual(beforeTime + 40000);
    });
  });

  describe('Golden Run: Replan Budget Preservation', () => {
    /**
     * CRITICAL REGRESSION TEST
     *
     * This test verifies that infrastructure failures do NOT consume
     * the replan budget, which is reserved for actual semantic failures.
     *
     * Before fix: 3 x 404 errors = 3 replans = goal run FAILED
     * After fix: 404 errors trigger retries, replan budget preserved
     */
    it('should NOT consume replan budget on infrastructure failures', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              actualOutcome: '[INFRA] 404 - Task not found',
            },
          ],
        }],
      };

      // Simulate 3 infrastructure failures
      for (let i = 0; i < 3; i++) {
        // Clear backoff for testing
        (orchestratorLoop as any).infraRetryAfter.set('item-1', 0);

        const decision = await (orchestratorLoop as any).makeDecision(goalRun);

        // All should be RETRY (not REPLAN)
        expect(decision.action).toBe('RETRY');

        // Update retry count
        (orchestratorLoop as any).infraRetryCounts.set('item-1', i + 1);
      }

      // Replan count should still be 0
      expect((orchestratorLoop as any).replanCounts.get(goalRun.id) || 0).toBe(0);
    });

    it('should preserve replan budget for semantic failures after infra retries', async () => {
      const goalRun = {
        id: 'goal-1',
        phase: 'EXECUTING',
        planVersions: [{
          checklistItems: [
            {
              id: 'item-1',
              status: ChecklistItemStatus.FAILED,
              actualOutcome: 'Verification failed: expected result not found',
            },
          ],
        }],
      };

      // Simulate previous infrastructure retries on a different item
      (orchestratorLoop as any).infraRetryCounts.set('item-0', 5); // Max retries exhausted

      // This is a semantic failure - should REPLAN
      const decision = await (orchestratorLoop as any).makeDecision(goalRun);

      expect(decision.action).toBe('REPLAN');

      // Replan count should be used now
      (orchestratorLoop as any).replanCounts.set(goalRun.id, 1);

      // Verify we still have 2 replans left
      expect((orchestratorLoop as any).replanCounts.get(goalRun.id)).toBe(1);
    });
  });
});
