/**
 * Jest E2E Test Setup
 *
 * This file runs before all E2E tests to configure the test environment.
 */

// Increase timeout for workflow tests
jest.setTimeout(120000);

// Suppress console output during tests (optional)
if (process.env.SUPPRESS_LOGS === 'true') {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
}

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
process.env.TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || 'test';
process.env.TEMPORAL_TASK_QUEUE = 'test-goal-runs';

// Mock external service URLs
process.env.ORCHESTRATOR_URL = 'http://localhost:3001';
process.env.TASK_CONTROLLER_URL = 'http://localhost:3002';
process.env.LLM_PROXY_URL = 'http://localhost:3003';
process.env.KAFKA_BROKERS = 'localhost:9092';
