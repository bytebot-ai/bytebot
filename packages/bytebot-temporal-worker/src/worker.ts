/**
 * Temporal Worker Entry Point
 *
 * This is the main entry point for the Temporal worker process.
 * It creates and runs a worker that executes Butler Vantage workflows.
 *
 * Production features:
 * - HTTP server starts FIRST for health check endpoints
 * - Graceful shutdown handling
 * - Prometheus metrics export
 * - Connection retry with backoff
 * - Health status updates throughout startup
 */

import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { Worker, bundleWorkflowCode, NativeConnection } from '@temporalio/worker';
import { AppModule } from './app.module';
import { HealthController } from './health/health.controller';
import {
  createTemporalConnection,
  closeTemporalConnection,
  getTemporalConfig,
} from './config/temporal.config';

// Phase 10.1: Metrics service for enhanced observability
import { MetricsService, setMetricsServiceInstance } from './metrics';

// Import activities
import * as planningActivities from './activities/planning.activities';
import * as executionActivities from './activities/execution.activities';
import * as kafkaActivities from './activities/kafka.activities';

// ============================================================================
// Worker State
// ============================================================================

let worker: Worker | null = null;
let nestApp: INestApplication | null = null;
let healthController: HealthController | null = null;
let isShuttingDown = false;

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const config = getTemporalConfig();

  console.log('Starting Butler Vantage Temporal Worker...');
  console.log(`  Address: ${config.address}`);
  console.log(`  Namespace: ${config.namespace}`);
  console.log(`  Task Queue: ${config.taskQueue}`);
  console.log(`  Max Concurrent Activities: ${config.maxConcurrentActivityTaskExecutions}`);
  console.log(`  Max Concurrent Workflows: ${config.maxConcurrentWorkflowTaskExecutions}`);

  // =========================================================================
  // STEP 1: Start HTTP server FIRST for health checks
  // This ensures Kubernetes startup probes succeed immediately
  // =========================================================================
  console.log('Starting HTTP health server...');
  const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);

  nestApp = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  await nestApp.listen(httpPort);
  console.log(`HTTP health server running on port ${httpPort}`);

  // Get reference to health controller to update state
  healthController = nestApp.get(HealthController);

  // Phase 10.1: Initialize metrics service for activities
  try {
    const metricsService = nestApp.get(MetricsService);
    setMetricsServiceInstance(metricsService);
    console.log('Metrics service initialized for activities');
  } catch (e) {
    console.warn('MetricsService not available, continuing without activity metrics');
  }

  // =========================================================================
  // STEP 2: Connect to Temporal with retry
  // Health endpoints are now available during this phase
  // =========================================================================
  let connection: NativeConnection | undefined;
  let retryCount = 0;
  const maxRetries = 10;
  const baseDelay = 1000;

  while (retryCount < maxRetries) {
    try {
      connection = await createTemporalConnection();
      console.log('Connected to Temporal server');

      // Update health controller with connection
      healthController!.getTemporalIndicator().setConnection(connection);
      break;
    } catch (error) {
      retryCount++;
      const delay = Math.min(baseDelay * Math.pow(2, retryCount), 30000);
      console.error(
        `Failed to connect to Temporal (attempt ${retryCount}/${maxRetries}):`,
        error instanceof Error ? error.message : error
      );

      if (retryCount >= maxRetries) {
        console.error('Max retries exceeded, exiting');
        process.exit(1);
      }

      console.log(`Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (!connection) {
    console.error('Failed to establish connection');
    process.exit(1);
  }

  // =========================================================================
  // STEP 3: Bundle workflow code
  // =========================================================================
  console.log('Bundling workflow code...');
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows/goal-run.workflow'),
  });

  // =========================================================================
  // STEP 4: Create and start worker
  // =========================================================================
  worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowBundle,

    // Register activities
    activities: {
      ...planningActivities,
      ...executionActivities,
      ...kafkaActivities,
    },

    // Performance tuning
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
    maxConcurrentLocalActivityExecutions: config.maxConcurrentLocalActivityExecutions,
    maxCachedWorkflows: config.maxCachedWorkflows,

    // Phase 10.4: Rate Limiting Configuration
    // Per-worker rate limit to protect downstream services
    maxActivitiesPerSecond: config.maxActivitiesPerSecond,
    // Task queue global rate limit (server-side)
    maxTaskQueueActivitiesPerSecond: config.maxTaskQueueActivitiesPerSecond,
    // Poller concurrency (controls task fetching parallelism)
    maxConcurrentActivityTaskPolls: config.maxConcurrentActivityTaskPolls,
    maxConcurrentWorkflowTaskPolls: config.maxConcurrentWorkflowTaskPolls,

    // Graceful shutdown
    shutdownGraceTime: '30s',

    // Enable sticky execution for better performance
    enableSDKTracing: true,
    stickyQueueScheduleToStartTimeout: '10s',
  });

  console.log('Worker created, starting...');

  // Update health controller - worker is now running
  healthController!.getTemporalIndicator().setWorkerRunning(true);
  healthController!.setReady(true);
  console.log('Worker is now READY - health checks will pass');

  // Setup graceful shutdown
  setupShutdownHandlers();

  // Run worker (blocks until shutdown)
  try {
    await worker.run();
  } catch (error) {
    if (!isShuttingDown) {
      console.error('Worker error:', error);
      process.exit(1);
    }
  }

  console.log('Worker stopped');
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

function setupShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.log('Shutdown already in progress...');
      return;
    }

    isShuttingDown = true;
    console.log(`Received ${signal}, initiating graceful shutdown...`);

    // Update health status to not ready
    if (healthController) {
      healthController.setReady(false);
      healthController.getTemporalIndicator().setWorkerRunning(false);
    }

    try {
      // Stop accepting new tasks
      if (worker) {
        console.log('Stopping worker...');
        worker.shutdown();
      }

      // Wait for in-flight tasks to complete (up to 30s)
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Close Temporal connection
      console.log('Closing Temporal connection...');
      await closeTemporalConnection();

      // Close NestJS application
      if (nestApp) {
        console.log('Closing HTTP server...');
        await nestApp.close();
      }

      console.log('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    shutdown('unhandledRejection');
  });
}

// ============================================================================
// Run
// ============================================================================

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
