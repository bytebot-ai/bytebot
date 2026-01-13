/**
 * Prisma Service
 * Database connection and query handling
 *
 * v1.1.0: Added connection pool limits to prevent database exhaustion
 * - connection_limit: Max connections per instance (default: 2)
 * - pool_timeout: Max seconds to wait for connection (default: 30)
 */

import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Build datasource URL with connection pool parameters
 * Prevents database connection exhaustion in multi-pod deployments
 */
function buildDatasourceUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';
  const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT || '2', 10);
  const poolTimeout = parseInt(process.env.DB_POOL_TIMEOUT || '30', 10);

  // Parse and append pool parameters
  const url = new URL(baseUrl);
  url.searchParams.set('connection_limit', connectionLimit.toString());
  url.searchParams.set('pool_timeout', poolTimeout.toString());

  return url.toString();
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const datasourceUrl = buildDatasourceUrl();
    super({
      datasourceUrl,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    // Log connection pool configuration
    const connectionLimit = process.env.DB_CONNECTION_LIMIT || '2';
    const poolTimeout = process.env.DB_POOL_TIMEOUT || '30';
    this.logger.log(
      `PrismaService initialized with connection_limit=${connectionLimit}, pool_timeout=${poolTimeout}`,
    );
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to database');

    // Log slow queries in development
    if (process.env.NODE_ENV !== 'production') {
      (this as any).$on('query', (e: any) => {
        if (e.duration > 100) {
          this.logger.warn(`Slow query (${e.duration}ms): ${e.query}`);
        }
      });
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Disconnected from database');
  }

  /**
   * Execute a transaction with retry on serialization failures
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check for serialization/deadlock errors (PostgreSQL)
        const isRetryable =
          error.code === '40001' || // Serialization failure
          error.code === '40P01' || // Deadlock
          error.code === 'P2034'; // Transaction conflict

        if (!isRetryable || attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff
        const delay = Math.min(100 * Math.pow(2, attempt - 1), 1000);
        this.logger.warn(
          `Transaction retry ${attempt}/${maxRetries} after ${delay}ms: ${error.code}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
