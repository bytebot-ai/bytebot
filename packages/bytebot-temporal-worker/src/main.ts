/**
 * ByteBot Temporal Worker - Main Entry Point
 *
 * This starts both:
 * 1. NestJS HTTP server for health checks and metrics
 * 2. Temporal worker for workflow/activity execution
 */

import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Create NestJS application for health/metrics
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Get port from environment
  const port = parseInt(process.env.HTTP_PORT ?? '3000', 10);

  // Start HTTP server
  await app.listen(port);
  logger.log(`Health/metrics server running on port ${port}`);

  // Import and start Temporal worker
  // Note: The worker is started in a separate process via worker.ts
  // This file is only for the HTTP health/metrics server
  logger.log('To start Temporal worker, run: npm run start:worker');
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
