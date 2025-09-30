/**
 * Custom error classes for typed error handling across the application
 */

export abstract class AppError extends Error {
  public readonly isAppError = true;
  
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorCode: string
  ) {
    super(message);
    this.name = this.constructor.name;
    
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Validation failed') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class DuplicateKeyError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'DUPLICATE_KEY_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized access') {
    super(message, 401, 'UNAUTHORIZED_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND_ERROR');
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 429, 'RATE_LIMIT_ERROR');
  }
}

export class NetworkError extends AppError {
  constructor(message: string = 'Network error occurred') {
    super(message, 502, 'NETWORK_ERROR');
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string = 'Configuration error') {
    super(message, 500, 'CONFIGURATION_ERROR');
  }
}

// Type guard to check if an error is one of our custom app errors
export function isAppError(error: unknown): error is AppError {
  return error instanceof Error && 'isAppError' in error && error.isAppError === true;
}

// Helper function to determine if an error should be retried
export function isRetryableError(error: AppError): boolean {
  return error instanceof NetworkError || error instanceof RateLimitError;
}