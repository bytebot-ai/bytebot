/**
 * Kafka Activities Unit Tests
 *
 * Tests event emission to Kafka topics with mocked KafkaJS client.
 */

import { MockActivityEnvironment } from '@temporalio/testing';
import { emitGoalEvent, emitStepEvent, emitAuditEvent, emitEventBatch } from './kafka.activities';

// Mock KafkaJS
const mockSend = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn().mockReturnValue({
      connect: mockConnect,
      disconnect: mockDisconnect,
      send: mockSend,
    }),
  })),
  CompressionTypes: { GZIP: 1 },
  logLevel: { WARN: 4 },
}));

describe('Kafka Activities', () => {
  let mockActivityEnv: MockActivityEnvironment;

  beforeEach(() => {
    mockActivityEnv = new MockActivityEnvironment();
    jest.clearAllMocks();
  });

  describe('emitGoalEvent', () => {
    it('should emit GOAL_STARTED event to correct topic', async () => {
      const input = {
        eventType: 'GOAL_STARTED' as const,
        goalRunId: 'goal-123',
        tenantId: 'tenant-abc',
        payload: { goalDescription: 'Test goal' },
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.goal.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              key: 'goal-123',
              value: expect.stringContaining('GOAL_STARTED'),
              headers: expect.objectContaining({
                'event-type': 'GOAL_STARTED',
                'tenant-id': 'tenant-abc',
                'correlation-id': 'goal-123',
              }),
            }),
          ]),
        })
      );
    });

    it('should emit GOAL_COMPLETED event with result payload', async () => {
      const input = {
        eventType: 'GOAL_COMPLETED' as const,
        goalRunId: 'goal-456',
        tenantId: 'tenant-xyz',
        payload: {
          stepsCompleted: 5,
          duration: 120000,
          summary: 'Goal completed successfully',
        },
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.goal.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              value: expect.stringContaining('stepsCompleted'),
            }),
          ]),
        })
      );
    });

    it('should emit GOAL_FAILED event with error details', async () => {
      const input = {
        eventType: 'GOAL_FAILED' as const,
        goalRunId: 'goal-789',
        tenantId: 'tenant-123',
        payload: {
          errorType: 'MAX_REPLANS_EXCEEDED',
          errorMessage: 'Failed after 3 replan attempts',
        },
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.goal.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              value: expect.stringContaining('MAX_REPLANS_EXCEEDED'),
            }),
          ]),
        })
      );
    });

    it('should also emit audit event for goal events', async () => {
      const input = {
        eventType: 'GOAL_CANCELLED' as const,
        goalRunId: 'goal-cancel-123',
        tenantId: 'tenant-audit',
        payload: { reason: 'User requested cancellation' },
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      // Should emit to both goal events and audit log
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'bytebot.goal.events' })
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'bytebot.audit.log' })
      );
    });
  });

  describe('emitStepEvent', () => {
    it('should emit STEP_STARTED event with step number', async () => {
      const input = {
        eventType: 'STEP_STARTED' as const,
        goalRunId: 'goal-step-123',
        tenantId: 'tenant-step',
        stepNumber: 3,
        payload: { description: 'Execute API test' },
      };

      await mockActivityEnv.run(emitStepEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.step.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              key: 'goal-step-123-3', // Composite key
              value: expect.stringContaining('STEP_STARTED'),
            }),
          ]),
        })
      );
    });

    it('should emit STEP_COMPLETED event with outcome', async () => {
      const input = {
        eventType: 'STEP_COMPLETED' as const,
        goalRunId: 'goal-step-456',
        tenantId: 'tenant-step',
        stepNumber: 2,
        payload: {
          outcome: 'API endpoint created successfully',
          artifacts: ['/src/api/users.ts'],
          knowledgeGained: ['API uses REST pattern'],
        },
      };

      await mockActivityEnv.run(emitStepEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.step.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              value: expect.stringContaining('STEP_COMPLETED'),
            }),
          ]),
        })
      );
    });

    it('should emit STEP_APPROVAL_REQUESTED for high-risk steps', async () => {
      const input = {
        eventType: 'STEP_APPROVAL_REQUESTED' as const,
        goalRunId: 'goal-highrisk',
        tenantId: 'tenant-approval',
        stepNumber: 1,
        payload: {
          description: 'Delete production database tables',
          riskLevel: 'HIGH',
          approvalRequired: true,
        },
      };

      await mockActivityEnv.run(emitStepEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.step.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              value: expect.stringContaining('STEP_APPROVAL_REQUESTED'),
            }),
          ]),
        })
      );
    });

    it('should emit STEP_REJECTED event with reason', async () => {
      const input = {
        eventType: 'STEP_REJECTED' as const,
        goalRunId: 'goal-rejected',
        tenantId: 'tenant-reject',
        stepNumber: 1,
        payload: {
          rejectedBy: 'admin-user',
          reason: 'Too risky for production environment',
        },
      };

      await mockActivityEnv.run(emitStepEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.step.events',
          messages: expect.arrayContaining([
            expect.objectContaining({
              value: expect.stringContaining('STEP_REJECTED'),
            }),
          ]),
        })
      );
    });
  });

  describe('emitAuditEvent', () => {
    it('should emit audit event with workflow metadata', async () => {
      const input = {
        eventType: 'goal.started',
        goalRunId: 'goal-audit-123',
        tenantId: 'tenant-audit',
        userId: 'user-abc',
        action: 'GOAL_STARTED',
        details: { source: 'web-ui' },
      };

      await mockActivityEnv.run(emitAuditEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'bytebot.audit.log',
          messages: expect.arrayContaining([
            expect.objectContaining({
              key: 'goal-audit-123',
              value: expect.stringContaining('goal.started'),
            }),
          ]),
        })
      );
    });

    it('should include user information when available', async () => {
      const input = {
        eventType: 'step.approved',
        goalRunId: 'goal-approval-audit',
        tenantId: 'tenant-approval',
        userId: 'approver-123',
        action: 'STEP_APPROVED',
        details: { stepNumber: 1, approvalTime: '2025-01-04T10:00:00Z' },
      };

      await mockActivityEnv.run(emitAuditEvent, input);

      const sentValue = JSON.parse(mockSend.mock.calls[0][0].messages[0].value);
      expect(sentValue.userId).toBe('approver-123');
      expect(sentValue.action).toBe('STEP_APPROVED');
    });
  });

  describe('emitEventBatch', () => {
    it('should emit multiple events in a single batch', async () => {
      const events = [
        {
          topic: 'GOAL_EVENTS' as const,
          key: 'goal-batch-1',
          event: {
            eventId: 'evt-1',
            eventType: 'GOAL_STARTED' as const,
            goalRunId: 'goal-batch-1',
            tenantId: 'tenant-batch',
            timestamp: '2025-01-04T10:00:00Z',
            payload: {},
          },
        },
        {
          topic: 'STEP_EVENTS' as const,
          key: 'goal-batch-1-1',
          event: {
            eventId: 'evt-2',
            eventType: 'STEP_STARTED' as const,
            goalRunId: 'goal-batch-1',
            tenantId: 'tenant-batch',
            stepNumber: 1,
            timestamp: '2025-01-04T10:00:01Z',
            payload: {},
          },
        },
      ];

      await mockActivityEnv.run(emitEventBatch, events);

      // Should send to both topics
      expect(mockSend).toHaveBeenCalled();
    });

    it('should handle empty batch gracefully', async () => {
      await mockActivityEnv.run(emitEventBatch, []);

      expect(mockSend).not.toHaveBeenCalled();
    });

    it('should group events by topic for efficiency', async () => {
      const events = [
        {
          topic: 'STEP_EVENTS' as const,
          key: 'goal-1-1',
          event: {
            eventId: 'evt-1',
            eventType: 'STEP_STARTED' as const,
            goalRunId: 'goal-1',
            tenantId: 'tenant-1',
            stepNumber: 1,
            timestamp: '2025-01-04T10:00:00Z',
            payload: {},
          },
        },
        {
          topic: 'STEP_EVENTS' as const,
          key: 'goal-1-2',
          event: {
            eventId: 'evt-2',
            eventType: 'STEP_COMPLETED' as const,
            goalRunId: 'goal-1',
            tenantId: 'tenant-1',
            stepNumber: 1,
            timestamp: '2025-01-04T10:00:01Z',
            payload: {},
          },
        },
      ];

      await mockActivityEnv.run(emitEventBatch, events);

      // Both events to same topic should be in single send
      const stepEventCalls = mockSend.mock.calls.filter(
        (call) => call[0].topic === 'bytebot.step.events'
      );
      expect(stepEventCalls.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle Kafka connection errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Connection refused'));

      const input = {
        eventType: 'GOAL_STARTED' as const,
        goalRunId: 'goal-error',
        tenantId: 'tenant-error',
        payload: {},
      };

      await expect(mockActivityEnv.run(emitGoalEvent, input)).rejects.toThrow(
        'Connection refused'
      );
    });

    it('should handle Kafka timeout errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Request timed out'));

      const input = {
        eventType: 'STEP_STARTED' as const,
        goalRunId: 'goal-timeout',
        tenantId: 'tenant-timeout',
        stepNumber: 1,
        payload: {},
      };

      await expect(mockActivityEnv.run(emitStepEvent, input)).rejects.toThrow(
        'Request timed out'
      );
    });
  });

  describe('Event Structure', () => {
    it('should include all required fields in goal event', async () => {
      const input = {
        eventType: 'GOAL_STARTED' as const,
        goalRunId: 'goal-structure',
        tenantId: 'tenant-structure',
        payload: { test: 'value' },
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      const sentValue = JSON.parse(mockSend.mock.calls[0][0].messages[0].value);
      expect(sentValue).toHaveProperty('eventId');
      expect(sentValue).toHaveProperty('eventType', 'GOAL_STARTED');
      expect(sentValue).toHaveProperty('goalRunId', 'goal-structure');
      expect(sentValue).toHaveProperty('tenantId', 'tenant-structure');
      expect(sentValue).toHaveProperty('timestamp');
      expect(sentValue).toHaveProperty('payload');
    });

    it('should use GZIP compression for messages', async () => {
      const input = {
        eventType: 'GOAL_STARTED' as const,
        goalRunId: 'goal-compress',
        tenantId: 'tenant-compress',
        payload: {},
      };

      await mockActivityEnv.run(emitGoalEvent, input);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          compression: 1, // GZIP
        })
      );
    });
  });
});
