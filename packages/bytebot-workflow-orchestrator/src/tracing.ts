/**
 * OpenTelemetry Tracing Configuration
 * v1.0.0: Nice-to-Have Enhancement for Distributed Tracing
 *
 * Configures OpenTelemetry SDK for distributed tracing across the
 * ByteBot multi-service architecture.
 *
 * Features:
 * - Auto-instrumentation for HTTP, Express, NestJS
 * - Custom spans for business logic
 * - Context propagation across service boundaries
 * - Trace export to Jaeger/Tempo
 *
 * IMPORTANT: This file must be imported BEFORE any NestJS modules.
 *
 * Usage in main.ts:
 * ```typescript
 * import otelSDK from './tracing';
 * await otelSDK.start();
 * // ... rest of bootstrap
 * ```
 *
 * @see /docs/CONTEXT_PROPAGATION_FIX_JAN_2026.md
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';

const isProduction = process.env.NODE_ENV === 'production';
const isTracingEnabled = process.env.OTEL_TRACING_ENABLED !== 'false';

// Service configuration
const serviceName = process.env.OTEL_SERVICE_NAME || 'bytebot-workflow-orchestrator';
const serviceVersion = process.env.npm_package_version || '1.0.0';

// Sampling configuration
// In production, sample a fraction of traces to reduce overhead
const samplingRate = isProduction
  ? parseFloat(process.env.OTEL_SAMPLING_RATE || '0.1') // 10% default in prod
  : 1.0; // 100% in development

// Export endpoint
const exporterEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  || 'http://localhost:4318/v1/traces';

// Create OTLP exporter for Jaeger/Tempo
const traceExporter = new OTLPTraceExporter({
  url: exporterEndpoint,
  headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
    ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    : {},
});

// Create the SDK with production-ready configuration
const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
    'service.namespace': 'bytebot',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),

  // Parent-based sampling with configurable rate
  sampler: new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(samplingRate),
  }),

  // Batch processing for efficient trace export
  spanProcessor: new BatchSpanProcessor(traceExporter, {
    maxQueueSize: isProduction ? 2048 : 512,
    maxExportBatchSize: isProduction ? 512 : 128,
    scheduledDelayMillis: isProduction ? 5000 : 1000,
    exportTimeoutMillis: 30000,
  }),

  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy file system instrumentation
      '@opentelemetry/instrumentation-fs': { enabled: false },

      // Configure HTTP instrumentation
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        ignoreIncomingRequestHook: (req) => {
          // Filter out health checks and metrics endpoints
          const ignorePaths = ['/health', '/ready', '/metrics', '/favicon.ico'];
          return ignorePaths.some((path) => req.url?.includes(path)) || false;
        },
      },

      // NestJS instrumentation
      '@opentelemetry/instrumentation-nestjs-core': {
        enabled: true,
      },

      // Express instrumentation (underlying HTTP server)
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
    }),
  ],
});

// Graceful shutdown handling
const shutdown = async () => {
  console.log('Shutting down OpenTelemetry SDK...');
  try {
    await sdk.shutdown();
    console.log('OpenTelemetry SDK shut down successfully');
  } catch (err) {
    console.error('Error shutting down OpenTelemetry SDK', err);
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Export a wrapper that can be conditionally started
export const otelSDK = {
  start: async () => {
    if (!isTracingEnabled) {
      console.log('OpenTelemetry tracing disabled via OTEL_TRACING_ENABLED=false');
      return;
    }

    try {
      await sdk.start();
      console.log(`OpenTelemetry SDK started (service: ${serviceName}, sampling: ${samplingRate * 100}%)`);
    } catch (err) {
      console.error('Failed to start OpenTelemetry SDK:', err);
    }
  },
  shutdown,
};

export default otelSDK;
