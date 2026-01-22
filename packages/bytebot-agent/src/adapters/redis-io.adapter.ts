/**
 * Redis IO Adapter for Socket.IO
 * v2.2.12: Enables WebSocket event broadcasting across multiple replicas
 *
 * This adapter uses Redis pub/sub to synchronize Socket.IO events across
 * all bytebot-agent instances, ensuring that task updates reach all connected
 * clients regardless of which replica they're connected to.
 *
 * @see https://socket.io/docs/v4/redis-adapter/
 * @see https://docs.nestjs.com/websockets/adapter
 */

import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, RedisClientType } from 'redis';
import { Logger } from '@nestjs/common';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter>;
  private pubClient: RedisClientType;
  private subClient: RedisClientType;

  /**
   * Connect to Redis and create the Socket.IO adapter
   *
   * Must be called before the application starts listening.
   * Uses REDIS_URL environment variable or defaults to localhost.
   */
  async connectToRedis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    this.logger.log(`Connecting to Redis at ${redisUrl}...`);

    try {
      // Create pub/sub clients with socket configuration
      // The pub client publishes events, the sub client subscribes to receive events
      // v2.2.12: Added socket options to fix connection timeout issues
      this.pubClient = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: 30000, // 30 second connection timeout
          reconnectStrategy: (retries: number) => {
            // Exponential backoff with max of 10 seconds
            const delay = Math.min(retries * 100, 10000);
            this.logger.log(`Redis reconnect attempt ${retries}, waiting ${delay}ms`);
            return delay;
          },
        },
      });
      this.subClient = this.pubClient.duplicate();

      // Set up event handlers before connecting
      this.pubClient.on('error', (err) => {
        this.logger.error(`Redis pub client error: ${err.message}`);
      });
      this.pubClient.on('connect', () => {
        this.logger.log('Redis pub client connecting...');
      });
      this.pubClient.on('ready', () => {
        this.logger.log('Redis pub client ready');
      });

      this.subClient.on('error', (err) => {
        this.logger.error(`Redis sub client error: ${err.message}`);
      });
      this.subClient.on('connect', () => {
        this.logger.log('Redis sub client connecting...');
      });
      this.subClient.on('ready', () => {
        this.logger.log('Redis sub client ready');
      });

      // Connect both clients
      await Promise.all([this.pubClient.connect(), this.subClient.connect()]);

      // Create the Socket.IO adapter with the Redis clients
      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);

      this.logger.log('Successfully connected to Redis for Socket.IO adapter');
    } catch (error) {
      this.logger.error(`Failed to connect to Redis: ${error.message}`);
      this.logger.warn(
        'Socket.IO will run without Redis adapter - events will NOT broadcast across replicas',
      );
      // Don't throw - allow the app to start without Redis (degraded mode)
      // This ensures the app doesn't crash if Redis is temporarily unavailable
    }
  }

  /**
   * Create the Socket.IO server with the Redis adapter
   *
   * If Redis connection failed, falls back to default adapter (no cross-replica events)
   */
  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);

    // Only use Redis adapter if we successfully connected
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
      this.logger.log(
        'Socket.IO server using Redis adapter for cross-replica events',
      );
    } else {
      this.logger.warn(
        'Socket.IO server running WITHOUT Redis adapter - single replica mode',
      );
    }

    return server;
  }

  /**
   * Clean up Redis connections on shutdown
   */
  async close(): Promise<void> {
    this.logger.log('Closing Redis connections...');

    const closePromises: Promise<void>[] = [];

    if (this.pubClient?.isOpen) {
      closePromises.push(
        this.pubClient.quit().then(() => {}).catch((err) => {
          this.logger.error(`Error closing pub client: ${err.message}`);
        }),
      );
    }

    if (this.subClient?.isOpen) {
      closePromises.push(
        this.subClient.quit().then(() => {}).catch((err) => {
          this.logger.error(`Error closing sub client: ${err.message}`);
        }),
      );
    }

    await Promise.all(closePromises);
    this.logger.log('Redis connections closed');
  }
}
