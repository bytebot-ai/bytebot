/**
 * Golden Run Regression Test: Workspace Provisioning
 *
 * This test suite verifies the fix for the runaway loop bug where
 * workspace provisioning failures caused infinite workflow creation.
 *
 * Bug: When workspace provisioning failed (e.g., capacity timeout),
 *      the error was thrown before linkWorkflowRun() was called,
 *      leaving goalRun.workflowRunId as NULL. This caused the
 *      orchestrator loop to create a NEW workflow on each iteration.
 *
 * Fix: "Link first, provision second" pattern
 *      1. Create workflow record (DB only)
 *      2. LINK to goal run immediately
 *      3. Attempt provisioning (may fail, that's OK)
 *      4. Use WAITING_FOR_CAPACITY status with exponential backoff
 *
 * @see https://book.kubebuilder.io/reference/good-practices (idempotency)
 */

import { WorkflowService, WorkspaceProvisioningStatus, WorkflowStatus } from '../src/services/workflow.service';

// Mock modules before importing
jest.mock('../src/services/prisma.service');
jest.mock('../src/services/workspace.service');

describe('WorkspaceProvisioning', () => {
  let workflowService: WorkflowService;
  let mockPrisma: any;
  let mockWorkspaceService: any;
  let mockEventEmitter: any;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create mock services with jest.fn()
    mockPrisma = {
      $transaction: jest.fn(),
      workspace: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      workflowRun: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      workflowNode: {
        create: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    mockWorkspaceService = {
      ensureWorkspaceDesktop: jest.fn(),
      hibernateWorkspace: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    // Create service instance with mocked dependencies
    workflowService = new WorkflowService(
      mockPrisma,
      mockWorkspaceService,
      mockEventEmitter,
    );
  });

  describe('isCapacityError (detection)', () => {
    // Test the capacity error detection patterns
    const capacityErrors = [
      'Timeout waiting for pod to become ready',
      'Pod not ready after 60 seconds',
      'Insufficient cpu to schedule pod',
      'Node unschedulable',
      'No nodes available matching pod affinity',
      '0/8 nodes are available: Insufficient memory',
      'Quota exceeded for resource cpu',
      'Too many requests (429)',
      'DeadlineExceeded: context deadline exceeded',
      'Cluster at capacity',
    ];

    const nonCapacityErrors = [
      'Invalid configuration: missing API key',
      'Authentication failed',
      'Permission denied',
      'Image not found: jbutler1980/bytebot-desktop:v9999',
      'Secret "credentials" not found',
    ];

    capacityErrors.forEach((errorMsg) => {
      it(`should detect "${errorMsg.substring(0, 30)}..." as capacity error`, () => {
        const isCapacity = (workflowService as any).isCapacityError(errorMsg);
        expect(isCapacity).toBe(true);
      });
    });

    nonCapacityErrors.forEach((errorMsg) => {
      it(`should NOT detect "${errorMsg.substring(0, 30)}..." as capacity error`, () => {
        const isCapacity = (workflowService as any).isCapacityError(errorMsg);
        expect(isCapacity).toBe(false);
      });
    });
  });

  describe('createWorkflowRecord (DB-only creation)', () => {
    it('should create workflow record without calling ensureWorkspaceDesktop', async () => {
      const mockWorkspace = { id: 'ws-test', tenantId: 'tenant-1' };
      const mockWorkflowRun = { id: 'wf-test', createdAt: new Date() };

      mockPrisma.$transaction.mockImplementation(async (callback: any) => {
        return callback({
          workspace: { create: jest.fn().mockResolvedValue(mockWorkspace) },
          workflowRun: { create: jest.fn().mockResolvedValue(mockWorkflowRun) },
          workflowNode: { create: jest.fn().mockResolvedValue({}) },
        });
      });

      const result = await workflowService.createWorkflowRecord({
        tenantId: 'tenant-1',
        nodes: [],
      });

      // Verify workflow record was created
      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.workspaceId).toBeDefined();
      expect(result.status).toBe(WorkflowStatus.PENDING);

      // CRITICAL: workspaceService.ensureWorkspaceDesktop should NOT be called
      expect(mockWorkspaceService.ensureWorkspaceDesktop).not.toHaveBeenCalled();

      // Verify record-created event was emitted (not workflow.created)
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'workflow.record-created',
        expect.objectContaining({
          workflowId: expect.any(String),
          workspaceId: expect.any(String),
        }),
      );
    });
  });

  describe('ensureWorkspaceProvisioned (idempotent provisioning)', () => {
    it('should return success immediately if workspace is already READY (idempotent)', async () => {
      const workflowId = 'wf-test';
      const workspaceId = 'ws-test';

      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: workflowId,
        workspace: {
          id: workspaceId,
          status: WorkspaceProvisioningStatus.READY,
        },
      });

      const result = await workflowService.ensureWorkspaceProvisioned(
        workflowId,
        'tenant-1',
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe(WorkspaceProvisioningStatus.READY);

      // CRITICAL: workspaceService was NOT called (idempotent skip)
      expect(mockWorkspaceService.ensureWorkspaceDesktop).not.toHaveBeenCalled();
    });

    it('should return FAILED without retrying if status is already FAILED', async () => {
      const workflowId = 'wf-test';

      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: workflowId,
        workspace: {
          id: 'ws-test',
          status: WorkspaceProvisioningStatus.FAILED,
          error: 'Previous failure',
        },
      });

      const result = await workflowService.ensureWorkspaceProvisioned(
        workflowId,
        'tenant-1',
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(WorkspaceProvisioningStatus.FAILED);
      expect(result.error).toBe('Previous failure');

      // CRITICAL: workspaceService was NOT called
      expect(mockWorkspaceService.ensureWorkspaceDesktop).not.toHaveBeenCalled();
    });

    it('should set WAITING_FOR_CAPACITY on timeout error (not FAILED)', async () => {
      const workflowId = 'wf-test';
      const workspaceId = 'ws-test';

      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: workflowId,
        workspace: {
          id: workspaceId,
          status: WorkspaceProvisioningStatus.PENDING,
          provisioningAttemptCount: 0,
        },
      });

      // Simulate timeout error
      mockWorkspaceService.ensureWorkspaceDesktop.mockRejectedValue(
        new Error('Timeout waiting for pod to become ready'),
      );

      const result = await workflowService.ensureWorkspaceProvisioned(
        workflowId,
        'tenant-1',
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe(WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY);
      expect(result.retryAfterMs).toBeDefined();
      expect(result.retryAfterMs).toBeGreaterThan(0);

      // CRITICAL: Workspace was updated to WAITING_FOR_CAPACITY, not FAILED
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          }),
        }),
      );
    });

    it('should implement exponential backoff for WAITING_FOR_CAPACITY', async () => {
      const workflowId = 'wf-test';
      const workspaceId = 'ws-test';
      const lastAttemptTime = new Date();

      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: workflowId,
        workspace: {
          id: workspaceId,
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          provisioningAttemptCount: 2, // 3rd attempt
          lastProvisioningAttemptAt: lastAttemptTime,
        },
      });

      const result = await workflowService.ensureWorkspaceProvisioned(
        workflowId,
        'tenant-1',
      );

      // Should return waiting status with backoff time
      expect(result.success).toBe(false);
      expect(result.status).toBe(WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY);
      expect(result.retryAfterMs).toBeDefined();
    });
  });

  describe('Golden Run: Runaway Loop Prevention', () => {
    /**
     * CRITICAL REGRESSION TEST
     *
     * This test simulates the exact scenario that caused the runaway loop:
     * 1. Create a workflow
     * 2. Provisioning fails with timeout
     * 3. Verify workflow is created (for linking)
     * 4. Verify status is WAITING_FOR_CAPACITY (not FAILED)
     * 5. Verify subsequent calls are idempotent (no new workflows created)
     */
    it('should NOT create new workflows when provisioning fails (runaway loop fix)', async () => {
      const tenantId = 'tenant-test';
      let createCallCount = 0;
      let createdWorkflowId: string | null = null;
      let createdWorkspaceId: string | null = null;

      // Mock transaction to track workflow creation
      mockPrisma.$transaction.mockImplementation(async (callback: any) => {
        createCallCount++;
        const workflowId = `wf-${createCallCount}`;
        const workspaceId = `ws-${createCallCount}`;

        if (!createdWorkflowId) {
          createdWorkflowId = workflowId;
          createdWorkspaceId = workspaceId;
        }

        return callback({
          workspace: {
            create: jest.fn().mockResolvedValue({
              id: workspaceId,
              tenantId,
              status: WorkspaceProvisioningStatus.PENDING,
            }),
          },
          workflowRun: {
            create: jest.fn().mockResolvedValue({
              id: workflowId,
              createdAt: new Date(),
            }),
          },
          workflowNode: {
            create: jest.fn().mockResolvedValue({}),
          },
        });
      });

      // First call: Create workflow record
      const result1 = await workflowService.createWorkflowRecord({
        tenantId,
        nodes: [],
      });

      expect(result1.id).toBeDefined();
      expect(createCallCount).toBe(1);

      // Setup for provisioning failure
      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: result1.id,
        workspace: {
          id: result1.workspaceId,
          status: WorkspaceProvisioningStatus.PENDING,
          provisioningAttemptCount: 0,
        },
      });

      mockWorkspaceService.ensureWorkspaceDesktop.mockRejectedValue(
        new Error('Timeout waiting for pod'),
      );

      // Attempt provisioning (should fail with WAITING_FOR_CAPACITY)
      const provisionResult = await workflowService.ensureWorkspaceProvisioned(
        result1.id,
        tenantId,
      );

      expect(provisionResult.success).toBe(false);
      expect(provisionResult.status).toBe(WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY);

      // KEY ASSERTION: No new workflow was created (createCallCount still 1)
      expect(createCallCount).toBe(1);

      // Simulate orchestrator loop calling ensureWorkspaceProvisioned again
      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: result1.id,
        workspace: {
          id: result1.workspaceId,
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          provisioningAttemptCount: 1,
          lastProvisioningAttemptAt: new Date(),
        },
      });

      const provisionResult2 = await workflowService.ensureWorkspaceProvisioned(
        result1.id,
        tenantId,
      );

      // Should return backoff time without creating new workflow
      expect(provisionResult2.success).toBe(false);
      expect(provisionResult2.status).toBe(WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY);
      expect(provisionResult2.retryAfterMs).toBeDefined();

      // CRITICAL ASSERTION: Still only 1 workflow created (no runaway loop)
      expect(createCallCount).toBe(1);
    });

    it('should transition to READY when provisioning eventually succeeds', async () => {
      const workflowId = 'wf-test';
      const workspaceId = 'ws-test';
      const tenantId = 'tenant-1';

      // Setup workspace in WAITING_FOR_CAPACITY after backoff period
      mockPrisma.workflowRun.findUnique.mockResolvedValue({
        id: workflowId,
        workspace: {
          id: workspaceId,
          status: WorkspaceProvisioningStatus.WAITING_FOR_CAPACITY,
          provisioningAttemptCount: 2,
          lastProvisioningAttemptAt: new Date(Date.now() - 120000), // 2 minutes ago
        },
      });

      // Provisioning now succeeds
      mockWorkspaceService.ensureWorkspaceDesktop.mockResolvedValue({
        status: 'Running',
        ready: true,
      });

      const result = await workflowService.ensureWorkspaceProvisioned(
        workflowId,
        tenantId,
      );

      // Should succeed
      expect(result.success).toBe(true);
      expect(result.status).toBe(WorkspaceProvisioningStatus.READY);

      // Workspace should be updated to READY
      expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WorkspaceProvisioningStatus.READY,
          }),
        }),
      );

      // workflow.created event should be emitted
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'workflow.created',
        expect.objectContaining({
          workflowId,
          workspaceId,
        }),
      );
    });
  });
});
