import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { webcrypto } from 'crypto';
import { json, urlencoded } from 'express';
import { Logger, INestApplication } from '@nestjs/common';
import { RedisIoAdapter } from './adapters/redis-io.adapter';

// Polyfill for crypto global (required by @nestjs/schedule)
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as any;
}

const logger = new Logger('Bootstrap');
let app: INestApplication;

/**
 * Global error handlers for unhandled promise rejections and uncaught exceptions.
 * v2.0.28: Added to catch async errors that escape normal error handling.
 *
 * Best practice: Log the error with full context, then exit the process.
 * Use Kubernetes/PM2 to automatically restart the application.
 */
function setupGlobalErrorHandlers(): void {
  // Handle unhandled promise rejections (async errors not caught)
  process.on('unhandledRejection', (reason: Error | unknown, promise: Promise<unknown>) => {
    const timestamp = new Date().toISOString();
    const errorMessage = reason instanceof Error ? reason.message : String(reason);
    const errorStack = reason instanceof Error ? reason.stack : undefined;

    logger.error({
      event: 'unhandledRejection',
      timestamp,
      error: errorMessage,
      stack: errorStack,
      promise: String(promise),
    });

    // In production, we log and let the process continue but track these
    // Kubernetes will restart the pod if it becomes unhealthy
    logger.error(
      `[${timestamp}] UNHANDLED REJECTION: ${errorMessage}\n${errorStack || 'No stack trace'}`,
    );
  });

  // Handle uncaught exceptions (sync errors not handled)
  process.on('uncaughtException', (error: Error, origin: string) => {
    const timestamp = new Date().toISOString();

    logger.error({
      event: 'uncaughtException',
      timestamp,
      error: error.message,
      stack: error.stack,
      origin,
    });

    logger.error(
      `[${timestamp}] UNCAUGHT EXCEPTION (${origin}): ${error.message}\n${error.stack || 'No stack trace'}`,
    );

    // For uncaught exceptions, we must exit - the process is in an undefined state
    // Kubernetes will automatically restart the pod
    process.exit(1);
  });

  // Handle graceful shutdown signals
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM signal received: starting graceful shutdown');
    await gracefulShutdown('SIGTERM');
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT signal received: starting graceful shutdown');
    await gracefulShutdown('SIGINT');
  });
}

/**
 * Graceful shutdown handler - closes connections cleanly before exit
 */
async function gracefulShutdown(signal: string): Promise<void> {
  const shutdownTimeout = setTimeout(() => {
    logger.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000); // 10 second timeout

  try {
    if (app) {
      await app.close();
      logger.log('Application closed successfully');
    }
    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    logger.error(`Error during ${signal} shutdown:`, error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

async function bootstrap() {
  logger.log('Starting bytebot-agent application (v2.2.14)...');

  // Set up global error handlers BEFORE creating the app
  setupGlobalErrorHandlers();

  try {
    app = await NestFactory.create(AppModule);

    // v2.2.12: Configure Redis adapter for WebSocket cross-replica events
    // This ensures task updates are broadcast to all connected clients
    // regardless of which replica they're connected to
    const redisIoAdapter = new RedisIoAdapter(app);
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
    logger.log('WebSocket Redis adapter configured');

    // Configure body parser with increased payload size limit (50MB)
    app.use(json({ limit: '50mb' }));
    app.use(urlencoded({ limit: '50mb', extended: true }));

    // Enable CORS
    app.enableCors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    });

    const port = process.env.PORT ?? 9991;
    await app.listen(port);
    logger.log(`Application listening on port ${port}`);
    logger.log('Global error handlers initialized');
  } catch (error) {
    logger.error('Error starting application:', error);
    process.exit(1);
  }
}
bootstrap();
