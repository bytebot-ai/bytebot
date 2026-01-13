/**
 * Workflow Load Testing Script
 *
 * Tests concurrent workflow execution and measures performance metrics.
 * Uses Temporal's workflow client to simulate production load.
 *
 * Usage:
 *   npx ts-node test/load/workflow-load-test.ts [options]
 *
 * Options:
 *   --workflows=N       Number of concurrent workflows (default: 10)
 *   --duration=N        Test duration in seconds (default: 60)
 *   --ramp-up=N         Ramp-up period in seconds (default: 10)
 *   --temporal-address  Temporal server address (default: localhost:7233)
 */

import { Connection, Client } from '@temporalio/client';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Configuration
// ============================================================================

interface LoadTestConfig {
  temporalAddress: string;
  namespace: string;
  taskQueue: string;
  workflowCount: number;
  durationSeconds: number;
  rampUpSeconds: number;
  tenantId: string;
}

function parseArgs(): LoadTestConfig {
  const args = process.argv.slice(2);
  const config: LoadTestConfig = {
    temporalAddress: process.env.TEMPORAL_ADDRESS || 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE || 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'goal-runs',
    workflowCount: 10,
    durationSeconds: 60,
    rampUpSeconds: 10,
    tenantId: 'load-test-tenant',
  };

  for (const arg of args) {
    if (arg.startsWith('--workflows=')) {
      config.workflowCount = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--duration=')) {
      config.durationSeconds = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--ramp-up=')) {
      config.rampUpSeconds = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--temporal-address=')) {
      config.temporalAddress = arg.split('=')[1];
    }
  }

  return config;
}

// ============================================================================
// Metrics Collection
// ============================================================================

interface WorkflowMetrics {
  workflowId: string;
  startTime: number;
  endTime?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration?: number;
  error?: string;
}

interface LoadTestResults {
  startTime: Date;
  endTime: Date;
  totalWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  throughputPerSecond: number;
  errorRate: number;
}

class MetricsCollector {
  private metrics: Map<string, WorkflowMetrics> = new Map();

  start(workflowId: string): void {
    this.metrics.set(workflowId, {
      workflowId,
      startTime: Date.now(),
      status: 'running',
    });
  }

  complete(workflowId: string): void {
    const metric = this.metrics.get(workflowId);
    if (metric) {
      metric.endTime = Date.now();
      metric.duration = metric.endTime - metric.startTime;
      metric.status = 'completed';
    }
  }

  fail(workflowId: string, error: string): void {
    const metric = this.metrics.get(workflowId);
    if (metric) {
      metric.endTime = Date.now();
      metric.duration = metric.endTime - metric.startTime;
      metric.status = 'failed';
      metric.error = error;
    }
  }

  getResults(startTime: Date, endTime: Date): LoadTestResults {
    const durations: number[] = [];
    let completed = 0;
    let failed = 0;

    for (const metric of this.metrics.values()) {
      if (metric.status === 'completed' && metric.duration) {
        completed++;
        durations.push(metric.duration);
      } else if (metric.status === 'failed') {
        failed++;
      }
    }

    durations.sort((a, b) => a - b);

    const percentile = (p: number) => {
      if (durations.length === 0) return 0;
      const idx = Math.ceil((p / 100) * durations.length) - 1;
      return durations[Math.max(0, idx)];
    };

    const testDurationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    return {
      startTime,
      endTime,
      totalWorkflows: this.metrics.size,
      completedWorkflows: completed,
      failedWorkflows: failed,
      avgDurationMs: durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
      minDurationMs: durations.length > 0 ? durations[0] : 0,
      maxDurationMs: durations.length > 0 ? durations[durations.length - 1] : 0,
      p50DurationMs: percentile(50),
      p95DurationMs: percentile(95),
      p99DurationMs: percentile(99),
      throughputPerSecond: completed / testDurationSeconds,
      errorRate: this.metrics.size > 0 ? (failed / this.metrics.size) * 100 : 0,
    };
  }
}

// ============================================================================
// Load Test Runner
// ============================================================================

async function runLoadTest(config: LoadTestConfig): Promise<LoadTestResults> {
  console.log('='.repeat(60));
  console.log('ByteBot Temporal Workflow Load Test');
  console.log('='.repeat(60));
  console.log(`Configuration:`);
  console.log(`  Temporal Address: ${config.temporalAddress}`);
  console.log(`  Namespace: ${config.namespace}`);
  console.log(`  Task Queue: ${config.taskQueue}`);
  console.log(`  Concurrent Workflows: ${config.workflowCount}`);
  console.log(`  Duration: ${config.durationSeconds}s`);
  console.log(`  Ramp-up: ${config.rampUpSeconds}s`);
  console.log('='.repeat(60));

  // Connect to Temporal
  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  const collector = new MetricsCollector();
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + config.durationSeconds * 1000);

  // Calculate workflow start intervals for ramp-up
  const intervalMs = (config.rampUpSeconds * 1000) / config.workflowCount;

  console.log('\nStarting workflows with ramp-up...\n');

  // Start workflows with ramp-up
  const workflowPromises: Promise<void>[] = [];

  for (let i = 0; i < config.workflowCount; i++) {
    const delay = i * intervalMs;

    const promise = new Promise<void>((resolve) => {
      setTimeout(async () => {
        const workflowId = `load-test-${uuidv4()}`;

        try {
          collector.start(workflowId);

          const handle = await client.workflow.start('goalRunWorkflow', {
            args: [{
              goalRunId: workflowId,
              tenantId: config.tenantId,
              userId: 'load-test-user',
              goalDescription: `Load test goal ${i + 1} of ${config.workflowCount}`,
              workspaceId: 'load-test-workspace',
              constraints: {
                maxSteps: 5,
                maxRetries: 2,
                maxReplans: 1,
                timeoutMs: 300000,
                requireApprovalForHighRisk: false,
              },
            }],
            taskQueue: config.taskQueue,
            workflowId,
          });

          // Wait for completion
          await handle.result();
          collector.complete(workflowId);

          process.stdout.write('.');
        } catch (error) {
          collector.fail(workflowId, error instanceof Error ? error.message : 'Unknown error');
          process.stdout.write('x');
        }

        resolve();
      }, delay);
    });

    workflowPromises.push(promise);
  }

  // Wait for all workflows to complete
  await Promise.all(workflowPromises);

  const actualEndTime = new Date();
  console.log('\n\nAll workflows completed.');

  // Generate results
  const results = collector.getResults(startTime, actualEndTime);

  // Print results
  console.log('\n' + '='.repeat(60));
  console.log('Load Test Results');
  console.log('='.repeat(60));
  console.log(`Total Workflows:     ${results.totalWorkflows}`);
  console.log(`Completed:           ${results.completedWorkflows}`);
  console.log(`Failed:              ${results.failedWorkflows}`);
  console.log(`Error Rate:          ${results.errorRate.toFixed(2)}%`);
  console.log('');
  console.log('Latency Metrics:');
  console.log(`  Average:           ${results.avgDurationMs.toFixed(2)}ms`);
  console.log(`  Min:               ${results.minDurationMs}ms`);
  console.log(`  Max:               ${results.maxDurationMs}ms`);
  console.log(`  P50:               ${results.p50DurationMs}ms`);
  console.log(`  P95:               ${results.p95DurationMs}ms`);
  console.log(`  P99:               ${results.p99DurationMs}ms`);
  console.log('');
  console.log(`Throughput:          ${results.throughputPerSecond.toFixed(2)} workflows/second`);
  console.log('='.repeat(60));

  await connection.close();

  return results;
}

// ============================================================================
// Stress Test (Burst Load)
// ============================================================================

async function runStressTest(config: LoadTestConfig): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Stress Test: Burst Load');
  console.log('='.repeat(60));

  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  // Start all workflows simultaneously
  const workflowIds: string[] = [];
  const startPromises: Promise<any>[] = [];

  console.log(`Starting ${config.workflowCount} workflows simultaneously...`);

  for (let i = 0; i < config.workflowCount; i++) {
    const workflowId = `stress-test-${uuidv4()}`;
    workflowIds.push(workflowId);

    startPromises.push(
      client.workflow.start('goalRunWorkflow', {
        args: [{
          goalRunId: workflowId,
          tenantId: config.tenantId,
          userId: 'stress-test-user',
          goalDescription: `Stress test goal ${i + 1}`,
          workspaceId: 'stress-test-workspace',
          constraints: {
            maxSteps: 3,
            maxRetries: 1,
            maxReplans: 1,
            timeoutMs: 120000,
            requireApprovalForHighRisk: false,
          },
        }],
        taskQueue: config.taskQueue,
        workflowId,
      })
    );
  }

  const startTime = Date.now();
  const handles = await Promise.all(startPromises);
  const launchDuration = Date.now() - startTime;

  console.log(`All ${config.workflowCount} workflows started in ${launchDuration}ms`);
  console.log('Waiting for completion...');

  // Wait for all to complete
  let completed = 0;
  let failed = 0;

  for (const handle of handles) {
    try {
      await handle.result();
      completed++;
    } catch {
      failed++;
    }
  }

  const totalDuration = Date.now() - startTime;

  console.log('\nStress Test Results:');
  console.log(`  Launch Time:    ${launchDuration}ms`);
  console.log(`  Total Time:     ${totalDuration}ms`);
  console.log(`  Completed:      ${completed}`);
  console.log(`  Failed:         ${failed}`);
  console.log(`  Launch Rate:    ${(config.workflowCount / (launchDuration / 1000)).toFixed(2)} workflows/second`);

  await connection.close();
}

// ============================================================================
// Soak Test (Extended Duration)
// ============================================================================

async function runSoakTest(config: LoadTestConfig): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Soak Test: Extended Duration');
  console.log('='.repeat(60));

  const connection = await Connection.connect({
    address: config.temporalAddress,
  });

  const client = new Client({
    connection,
    namespace: config.namespace,
  });

  // Run workflows continuously for the duration
  const endTime = Date.now() + config.durationSeconds * 1000;
  let totalStarted = 0;
  let totalCompleted = 0;
  let totalFailed = 0;

  const activeWorkflows: Set<Promise<void>> = new Set();
  const maxConcurrent = config.workflowCount;

  console.log(`Running with ${maxConcurrent} concurrent workflows for ${config.durationSeconds}s...`);

  const startWorkflow = async (): Promise<void> => {
    const workflowId = `soak-test-${uuidv4()}`;
    totalStarted++;

    try {
      const handle = await client.workflow.start('goalRunWorkflow', {
        args: [{
          goalRunId: workflowId,
          tenantId: config.tenantId,
          userId: 'soak-test-user',
          goalDescription: `Soak test goal ${totalStarted}`,
          workspaceId: 'soak-test-workspace',
          constraints: {
            maxSteps: 3,
            maxRetries: 1,
            maxReplans: 1,
            timeoutMs: 120000,
            requireApprovalForHighRisk: false,
          },
        }],
        taskQueue: config.taskQueue,
        workflowId,
      });

      await handle.result();
      totalCompleted++;
      process.stdout.write('.');
    } catch {
      totalFailed++;
      process.stdout.write('x');
    }
  };

  // Keep starting new workflows until end time
  while (Date.now() < endTime) {
    // Fill up to max concurrent
    while (activeWorkflows.size < maxConcurrent && Date.now() < endTime) {
      const promise = startWorkflow();
      activeWorkflows.add(promise);
      promise.finally(() => activeWorkflows.delete(promise));
    }

    // Wait a bit before checking again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Wait for remaining workflows
  await Promise.all(activeWorkflows);

  console.log('\n\nSoak Test Results:');
  console.log(`  Total Started:  ${totalStarted}`);
  console.log(`  Completed:      ${totalCompleted}`);
  console.log(`  Failed:         ${totalFailed}`);
  console.log(`  Throughput:     ${(totalCompleted / config.durationSeconds).toFixed(2)} workflows/second`);

  await connection.close();
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  try {
    // Run standard load test
    await runLoadTest(config);

    // Optionally run stress test
    if (process.argv.includes('--stress')) {
      await runStressTest(config);
    }

    // Optionally run soak test
    if (process.argv.includes('--soak')) {
      await runSoakTest(config);
    }

    console.log('\nLoad testing completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Load test failed:', error);
    process.exit(1);
  }
}

main();
