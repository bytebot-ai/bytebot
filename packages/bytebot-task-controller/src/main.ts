/**
 * ByteBot Task Controller
 * Phase 6.2: Manages ephemeral desktop pod lifecycle
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Main');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug'],
  });

  // Enable CORS for development
  app.enableCors();

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = process.env.PORT || 8080;
  await app.listen(port);

  logger.log(`Task Controller listening on port ${port}`);
  logger.log(`Metrics available at /metrics`);
  logger.log(`Health check at /healthz`);
  logger.log(`Readiness check at /readyz`);

  // Log configuration
  logger.log('Configuration:');
  logger.log(`  Leader Election: ${process.env.LEADER_ELECTION_ENABLED !== 'false' ? 'enabled' : 'disabled'}`);
  logger.log(`  Warm Pool Namespace: ${process.env.WARM_POOL_NAMESPACE || 'bytebot'}`);
  logger.log(`  Poll Interval: ${process.env.POLL_INTERVAL || '5000'}ms`);
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

bootstrap();
