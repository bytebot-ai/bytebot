/**
 * Temporal Configuration
 *
 * Production-ready configuration for Temporal workers.
 * Follows Temporal's recommended performance settings.
 *
 * Phase 10.4: Enhanced with rate limiting configuration
 *
 * @see https://docs.temporal.io/develop/worker-performance
 * @see https://typescript.temporal.io/api/interfaces/worker.WorkerOptions
 */

import { NativeConnection, Runtime } from '@temporalio/worker';

// ============================================================================
// Environment Configuration
// ============================================================================

export interface TemporalConfig {
  address: string;
  namespace: string;
  taskQueue: string;

  // Worker settings
  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
  maxConcurrentLocalActivityExecutions: number;
  maxCachedWorkflows: number;

  // Phase 10.4: Rate Limiting Configuration
  maxActivitiesPerSecond?: number;         // Per-worker activity rate limit
  maxTaskQueueActivitiesPerSecond?: number; // Task queue global rate limit
  maxConcurrentActivityTaskPolls: number;   // Concurrent activity pollers
  maxConcurrentWorkflowTaskPolls: number;   // Concurrent workflow pollers

  // Connection settings
  enableTLS: boolean;
  tlsCertPath?: string;
  tlsKeyPath?: string;

  // Observability
  enableMetrics: boolean;
  metricsPort: number;
}

export function getTemporalConfig(): TemporalConfig {
  return {
    // Connection
    address: process.env.TEMPORAL_ADDRESS ?? 'temporal-frontend.temporal.svc.cluster.local:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'bytebot',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'bytebot-goal-runs',

    // Worker concurrency (tune based on pod resources)
    // Best practice: Start conservative and tune up based on metrics
    maxConcurrentActivityTaskExecutions: parseInt(
      process.env.TEMPORAL_MAX_CONCURRENT_ACTIVITIES ?? '50', // Reduced from 100
      10
    ),
    maxConcurrentWorkflowTaskExecutions: parseInt(
      process.env.TEMPORAL_MAX_CONCURRENT_WORKFLOWS ?? '100', // Reduced from 200
      10
    ),
    maxConcurrentLocalActivityExecutions: parseInt(
      process.env.TEMPORAL_MAX_CONCURRENT_LOCAL_ACTIVITIES ?? '50', // Reduced from 100
      10
    ),
    maxCachedWorkflows: parseInt(process.env.TEMPORAL_MAX_CACHED_WORKFLOWS ?? '500', 10),

    // Phase 10.4: Rate Limiting Configuration
    // maxActivitiesPerSecond: Per-worker limit on activities/second
    // Protects downstream services (LLM, databases) from overload
    maxActivitiesPerSecond: process.env.TEMPORAL_MAX_ACTIVITIES_PER_SECOND
      ? parseFloat(process.env.TEMPORAL_MAX_ACTIVITIES_PER_SECOND)
      : 10, // Conservative default: 10 activities/sec per worker

    // maxTaskQueueActivitiesPerSecond: Global task queue rate limit
    // Applied server-side across all workers on this task queue
    maxTaskQueueActivitiesPerSecond: process.env.TEMPORAL_MAX_TASK_QUEUE_ACTIVITIES_PER_SECOND
      ? parseFloat(process.env.TEMPORAL_MAX_TASK_QUEUE_ACTIVITIES_PER_SECOND)
      : undefined, // No global limit by default (let workers self-regulate)

    // Poller configuration: Controls parallelism of task fetching
    // Recommended: half of max concurrent executions
    maxConcurrentActivityTaskPolls: parseInt(
      process.env.TEMPORAL_MAX_ACTIVITY_POLLERS ?? '25',
      10
    ),
    maxConcurrentWorkflowTaskPolls: parseInt(
      process.env.TEMPORAL_MAX_WORKFLOW_POLLERS ?? '50',
      10
    ),

    // TLS (for Temporal Cloud or mTLS)
    enableTLS: process.env.TEMPORAL_TLS_ENABLED === 'true',
    tlsCertPath: process.env.TEMPORAL_TLS_CERT_PATH,
    tlsKeyPath: process.env.TEMPORAL_TLS_KEY_PATH,

    // Observability
    enableMetrics: process.env.TEMPORAL_METRICS_ENABLED !== 'false',
    metricsPort: parseInt(process.env.TEMPORAL_METRICS_PORT ?? '9464', 10),
  };
}

// ============================================================================
// Connection Factory
// ============================================================================

let connection: NativeConnection | null = null;

export async function createTemporalConnection(): Promise<NativeConnection> {
  if (connection) {
    return connection;
  }

  const config = getTemporalConfig();

  // Configure runtime for production
  Runtime.install({
    telemetryOptions: {
      metrics: config.enableMetrics
        ? {
            prometheus: {
              bindAddress: `0.0.0.0:${config.metricsPort}`,
            },
          }
        : undefined,
    },
  });

  // Create connection with optional TLS
  if (config.enableTLS && config.tlsCertPath && config.tlsKeyPath) {
    const fs = await import('fs');
    connection = await NativeConnection.connect({
      address: config.address,
      tls: {
        clientCertPair: {
          crt: fs.readFileSync(config.tlsCertPath),
          key: fs.readFileSync(config.tlsKeyPath),
        },
      },
    });
  } else {
    connection = await NativeConnection.connect({
      address: config.address,
    });
  }

  return connection;
}

export async function closeTemporalConnection(): Promise<void> {
  if (connection) {
    await connection.close();
    connection = null;
  }
}

// ============================================================================
// Task Queue Configuration
// ============================================================================

export const TASK_QUEUES = {
  // Main task queue for goal run workflows
  GOAL_RUNS: 'bytebot-goal-runs',

  // Separate queue for planning activities (LLM-heavy)
  PLANNING: 'bytebot-planning',

  // Separate queue for execution activities (agent-heavy)
  EXECUTION: 'bytebot-execution',

  // Low-priority queue for non-critical activities
  LOW_PRIORITY: 'bytebot-low-priority',
} as const;

// ============================================================================
// Retry Policies
// ============================================================================

export const RETRY_POLICIES = {
  // For transient failures (network, rate limits)
  TRANSIENT: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 5,
  },

  // For LLM calls (may timeout)
  LLM: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '120s',
    maximumAttempts: 3,
  },

  // For critical operations (database, external APIs)
  CRITICAL: {
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 10,
  },

  // For non-critical operations (metrics, logs)
  NON_CRITICAL: {
    initialInterval: '100ms',
    backoffCoefficient: 1.5,
    maximumInterval: '5s',
    maximumAttempts: 3,
  },
} as const;

// ============================================================================
// Workflow Timeouts
// ============================================================================

export const WORKFLOW_TIMEOUTS = {
  // Default workflow execution timeout
  DEFAULT_EXECUTION: '24h',

  // Default workflow run timeout (single run)
  DEFAULT_RUN: '1h',

  // Maximum workflow execution timeout
  MAX_EXECUTION: '7d',

  // Activity timeouts
  PLANNING_ACTIVITY: '5m',
  EXECUTION_ACTIVITY: '10m',
  VERIFICATION_ACTIVITY: '2m',
  KAFKA_ACTIVITY: '10s',
} as const;
