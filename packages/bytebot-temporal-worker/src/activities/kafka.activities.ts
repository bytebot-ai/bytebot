/**
 * Kafka Activities - Event emission for observability
 *
 * These activities emit events to Kafka for:
 * - Real-time monitoring dashboards
 * - Audit logging and compliance
 * - Cross-service event sourcing
 *
 * Topic structure:
 * - bytebot.goal.events: Goal lifecycle events
 * - bytebot.step.events: Step execution events
 * - bytebot.audit.log: Compliance and audit trail
 */

import { Context } from '@temporalio/activity';
import { Kafka, Producer, CompressionTypes, logLevel } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';

import type {
  GoalEvent,
  StepEvent,
  AuditEvent,
} from '../types/goal-run.types';

// ============================================================================
// Configuration
// ============================================================================

// Kafka is in core cluster - accessible via ClusterMesh global service
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'core-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092').split(',');
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID ?? 'bytebot-temporal-worker';

// Topic names following naming convention: <domain>.<entity>.<event-type>
const TOPICS = {
  GOAL_EVENTS: process.env.KAFKA_TOPIC_GOAL_EVENTS ?? 'bytebot.goal.events',
  STEP_EVENTS: process.env.KAFKA_TOPIC_STEP_EVENTS ?? 'bytebot.step.events',
  AUDIT_LOG: process.env.KAFKA_TOPIC_AUDIT ?? 'bytebot.audit.log',
};

// ============================================================================
// Kafka Client Singleton
// ============================================================================

let kafka: Kafka | null = null;
let producer: Producer | null = null;
let isConnected = false;

async function getProducer(): Promise<Producer> {
  if (producer && isConnected) {
    return producer;
  }

  if (!kafka) {
    kafka = new Kafka({
      clientId: KAFKA_CLIENT_ID,
      brokers: KAFKA_BROKERS,
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 100,
        retries: 5,
        maxRetryTime: 30000,
      },
    });
  }

  if (!producer) {
    producer = kafka.producer({
      allowAutoTopicCreation: false, // Topics should be pre-created
      transactionTimeout: 30000,
    });
  }

  if (!isConnected) {
    await producer.connect();
    isConnected = true;
  }

  return producer;
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (producer && isConnected) {
    await producer.disconnect();
    isConnected = false;
  }
});

// ============================================================================
// Activity Interface
// ============================================================================

export interface KafkaActivities {
  emitGoalEvent(input: {
    eventType: GoalEvent['eventType'];
    goalRunId: string;
    tenantId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;

  emitStepEvent(input: {
    eventType: StepEvent['eventType'];
    goalRunId: string;
    tenantId: string;
    stepNumber: number;
    payload: Record<string, unknown>;
  }): Promise<void>;

  emitAuditEvent(input: {
    eventType: string;
    goalRunId: string;
    tenantId: string;
    userId?: string;
    action: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

// ============================================================================
// Activity Implementations
// ============================================================================

/**
 * Emits a goal lifecycle event to Kafka.
 *
 * Events: GOAL_STARTED, GOAL_COMPLETED, GOAL_FAILED, GOAL_CANCELLED, GOAL_PAUSED, GOAL_RESUMED
 */
export async function emitGoalEvent(input: {
  eventType: GoalEvent['eventType'];
  goalRunId: string;
  tenantId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const context = Context.current();
  context.heartbeat(`Emitting goal event: ${input.eventType}`);

  const event: GoalEvent = {
    eventId: uuidv4(),
    eventType: input.eventType,
    goalRunId: input.goalRunId,
    tenantId: input.tenantId,
    timestamp: new Date().toISOString(),
    payload: input.payload,
  };

  await emitEvent(TOPICS.GOAL_EVENTS, input.goalRunId, event);

  // Also emit to audit log for compliance
  await emitAuditEvent({
    eventType: `goal.${input.eventType.toLowerCase()}`,
    goalRunId: input.goalRunId,
    tenantId: input.tenantId,
    action: input.eventType,
    details: input.payload,
  });
}

/**
 * Emits a step execution event to Kafka.
 *
 * Events: STEP_STARTED, STEP_COMPLETED, STEP_FAILED, STEP_SKIPPED,
 *         STEP_APPROVAL_REQUESTED, STEP_APPROVED, STEP_REJECTED
 */
export async function emitStepEvent(input: {
  eventType: StepEvent['eventType'];
  goalRunId: string;
  tenantId: string;
  stepNumber: number;
  payload: Record<string, unknown>;
}): Promise<void> {
  const context = Context.current();
  context.heartbeat(`Emitting step event: ${input.eventType} for step ${input.stepNumber}`);

  const event: StepEvent = {
    eventId: uuidv4(),
    eventType: input.eventType,
    goalRunId: input.goalRunId,
    tenantId: input.tenantId,
    stepNumber: input.stepNumber,
    timestamp: new Date().toISOString(),
    payload: input.payload,
  };

  // Use composite key for ordering: goalRunId-stepNumber
  const key = `${input.goalRunId}-${input.stepNumber}`;
  await emitEvent(TOPICS.STEP_EVENTS, key, event);
}

/**
 * Emits an audit event for compliance and traceability.
 *
 * Audit events are immutable and retained for compliance periods.
 */
export async function emitAuditEvent(input: {
  eventType: string;
  goalRunId: string;
  tenantId: string;
  userId?: string;
  action: string;
  details: Record<string, unknown>;
}): Promise<void> {
  const context = Context.current();
  context.heartbeat(`Emitting audit event: ${input.eventType}`);

  const workflowInfo = getWorkflowMetadata();

  const event: AuditEvent = {
    eventId: uuidv4(),
    eventType: input.eventType,
    goalRunId: input.goalRunId,
    tenantId: input.tenantId,
    userId: input.userId,
    timestamp: new Date().toISOString(),
    action: input.action,
    details: input.details,
    metadata: workflowInfo,
  };

  await emitEvent(TOPICS.AUDIT_LOG, input.goalRunId, event);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Emits an event to Kafka with retry handling.
 */
async function emitEvent(
  topic: string,
  key: string,
  event: GoalEvent | StepEvent | AuditEvent
): Promise<void> {
  try {
    const prod = await getProducer();

    await prod.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key,
          value: JSON.stringify(event),
          headers: {
            'content-type': 'application/json',
            'event-type': event.eventType,
            'tenant-id': event.tenantId,
            'correlation-id': event.goalRunId,
            'timestamp': event.timestamp,
          },
        },
      ],
    });
  } catch (error) {
    // Log but don't fail the workflow for event emission failures
    console.error(`Failed to emit event to ${topic}:`, error);

    // Try to reconnect on next attempt
    if (error instanceof Error && error.message.includes('disconnect')) {
      isConnected = false;
    }

    // Rethrow for Temporal to handle retry
    throw error;
  }
}

/**
 * Gets workflow metadata for audit context.
 */
function getWorkflowMetadata(): {
  workflowId?: string;
  runId?: string;
  activityId?: string;
} {
  try {
    const context = Context.current();
    return {
      workflowId: context.info.workflowExecution?.workflowId,
      runId: context.info.workflowExecution?.runId,
      activityId: context.info.activityId,
    };
  } catch {
    return {};
  }
}

// ============================================================================
// Batch Operations (for high-throughput scenarios)
// ============================================================================

/**
 * Emits multiple events in a single batch for efficiency.
 * Used when emitting many events at once (e.g., workflow completion summary).
 */
export async function emitEventBatch(
  events: Array<{
    topic: 'GOAL_EVENTS' | 'STEP_EVENTS' | 'AUDIT_LOG';
    key: string;
    event: GoalEvent | StepEvent | AuditEvent;
  }>
): Promise<void> {
  if (events.length === 0) return;

  const context = Context.current();
  context.heartbeat(`Emitting batch of ${events.length} events`);

  try {
    const prod = await getProducer();

    // Group by topic
    const byTopic = new Map<string, Array<{ key: string; value: string; headers: Record<string, string> }>>();

    for (const { topic, key, event } of events) {
      const topicName = TOPICS[topic];
      if (!byTopic.has(topicName)) {
        byTopic.set(topicName, []);
      }
      byTopic.get(topicName)!.push({
        key,
        value: JSON.stringify(event),
        headers: {
          'content-type': 'application/json',
          'event-type': event.eventType,
          'tenant-id': event.tenantId,
        },
      });
    }

    // Send all topics in parallel
    await Promise.all(
      Array.from(byTopic.entries()).map(([topic, messages]) =>
        prod.send({
          topic,
          compression: CompressionTypes.GZIP,
          messages,
        })
      )
    );
  } catch (error) {
    console.error('Failed to emit event batch:', error);
    throw error;
  }
}
