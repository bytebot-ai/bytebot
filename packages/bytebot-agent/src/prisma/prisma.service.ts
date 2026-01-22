import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * v2.2.6: Maximum retry attempts for transient database errors
 * Handles PgBouncer prepared statement errors and connection issues
 */
const MAX_DB_RETRIES = 3;

/**
 * v2.2.6: Base delay for exponential backoff (in milliseconds)
 */
const BASE_RETRY_DELAY_MS = 100;

/**
 * v2.2.19: Build datasource URL with connection pool parameters
 * Prevents database connection exhaustion in multi-pod deployments
 */
function buildDatasourceUrl(): string {
  const baseUrl = process.env.DATABASE_URL || '';
  const connectionLimit = parseInt(process.env.DB_CONNECTION_LIMIT || '2', 10);
  const poolTimeout = parseInt(process.env.DB_POOL_TIMEOUT || '30', 10);

  // Parse and append pool parameters
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('connection_limit', connectionLimit.toString());
    url.searchParams.set('pool_timeout', poolTimeout.toString());
    return url.toString();
  } catch {
    // If URL parsing fails, return base URL (will use Prisma defaults)
    return baseUrl;
  }
}

/**
 * v2.2.6: Check if an error is a transient database error that should be retried
 *
 * Handles:
 * - PgBouncer prepared statement errors (code 26000)
 * - Connection errors (P1001, P1002, P1017)
 * - Network timeout errors
 */
function isRetryableError(error: any): boolean {
  // PostgreSQL prepared statement error (PgBouncer restart)
  if (error?.code === '26000' || error?.message?.includes('prepared statement')) {
    return true;
  }

  // Prisma connection errors
  const retryablePrismaCodes = ['P1001', 'P1002', 'P1017', 'P2024'];
  if (retryablePrismaCodes.includes(error?.code)) {
    return true;
  }

  // Connection-related error messages
  const connectionErrorPatterns = [
    'connection',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'socket hang up',
    'server closed',
  ];

  if (error?.message && connectionErrorPatterns.some(p =>
    error.message.toLowerCase().includes(p.toLowerCase())
  )) {
    return true;
  }

  return false;
}

/**
 * v2.2.6: Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const datasourceUrl = buildDatasourceUrl();
    super({
      datasourceUrl,
      log: [
        { level: 'error', emit: 'stdout' },
        { level: 'warn', emit: 'stdout' },
      ],
    });

    // Log connection pool configuration
    const connectionLimit = process.env.DB_CONNECTION_LIMIT || '2';
    const poolTimeout = process.env.DB_POOL_TIMEOUT || '30';
    this.logger.log(
      `PrismaService initialized with connection_limit=${connectionLimit}, pool_timeout=${poolTimeout}, retry support enabled`,
    );
  }

  async onModuleInit() {
    // Connect to the database
    await this.$connect();
    this.logger.log('Connected to PostgreSQL database');
  }

  /**
   * v2.2.6: Execute a database operation with retry logic
   * Use this wrapper for operations that may encounter transient errors
   *
   * @param operation - The database operation to execute
   * @param operationName - A descriptive name for logging
   * @returns The result of the operation
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_DB_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        if (isRetryableError(error) && attempt < MAX_DB_RETRIES) {
          const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          this.logger.warn(
            `[Retry ${attempt}/${MAX_DB_RETRIES}] Transient DB error in ${operationName}: ${error.message}. Retrying in ${delayMs}ms...`
          );
          await sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  /**
   * v2.2.6: Execute a transaction with retry logic
   * Wraps Prisma's $transaction with automatic retry on transient errors
   *
   * @param fn - The transaction function
   * @param operationName - A descriptive name for logging
   * @returns The result of the transaction
   */
  async transactionWithRetry<T>(
    fn: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>) => Promise<T>,
    operationName: string = 'transaction'
  ): Promise<T> {
    return this.executeWithRetry(
      () => this.$transaction(fn),
      operationName
    );
  }

  /**
   * v2.2.6: Execute a raw query with retry logic
   *
   * @param query - The raw SQL query
   * @param operationName - A descriptive name for logging
   * @returns The query result
   */
  async queryRawWithRetry<T = unknown>(
    query: Parameters<PrismaClient['$queryRaw']>[0],
    operationName: string = 'queryRaw'
  ): Promise<T> {
    return this.executeWithRetry(
      () => this.$queryRaw(query) as Promise<T>,
      operationName
    );
  }

  /**
   * v2.2.6: Execute a raw command with retry logic
   *
   * @param query - The raw SQL command
   * @param operationName - A descriptive name for logging
   * @returns The number of affected rows
   */
  async executeRawWithRetry(
    query: Parameters<PrismaClient['$executeRaw']>[0],
    operationName: string = 'executeRaw'
  ): Promise<number> {
    return this.executeWithRetry(
      () => this.$executeRaw(query),
      operationName
    );
  }
}
