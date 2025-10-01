import { Controller, Post, Get, Body, HttpCode, HttpStatus, HttpException, ValidationPipe, UsePipes, Logger } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { ApiKeyConfigDto } from './dto/api-key-config.dto';
import { TestApiKeyDto } from './dto/test-api-key.dto';
import {
  AppError,
  ValidationError,
  DuplicateKeyError,
  UnauthorizedError,
  NotFoundError,
  RateLimitError,
  NetworkError,
  isAppError
} from '../shared/errors';

@Controller('api-keys')
export class ApiKeysController {
  private readonly logger = new Logger(ApiKeysController.name);

  constructor(private readonly apiKeysService: ApiKeysService) {}

  /**
   * Masks sensitive data in API keys for logging
   */
  private maskApiKey(apiKey: string): string {
    if (!apiKey || apiKey.length <= 4) {
      return '****';
    }
    return '****' + apiKey.slice(-4);
  }

  /**
   * Logs error with sanitized information (no sensitive data)
   */
  private logSanitizedError(operation: string, error: any, provider?: string): void {
    const sanitizedLog: any = {
      operation,
      message: error.message,
      name: error.name,
      statusCode: error.statusCode || 'unknown'
    };

    if (provider) {
      sanitizedLog.provider = provider;
    }

    // Only include stack trace if it doesn't contain sensitive data
    if (error.stack && !error.stack.includes('api_key') && !error.stack.includes('API_KEY')) {
      sanitizedLog.stack = error.stack;
    }

    this.logger.error(`${operation} failed:`, sanitizedLog);
  }

  @Get('status')
  @HttpCode(HttpStatus.OK)
  async getApiKeyStatus() {
    try {
      const status = await this.apiKeysService.getApiKeyStatus();
      return { success: true, data: status };
    } catch (error) {
      // Log sanitized error information without sensitive data
      this.logSanitizedError('get API key status', error);
      
      // Map known error types to appropriate HTTP status codes
      if (error instanceof HttpException) {
        // Re-throw HttpExceptions as-is
        throw error;
      }
      
      // Fallback for unknown errors
      throw new HttpException('Failed to get API key status', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('save')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async saveApiKeys(@Body() config: ApiKeyConfigDto) {
    try {
      // Transform the config to the format expected by the service
      const apiKeys: Record<string, string> = {};
      
      if (config.anthropicApiKey) apiKeys.ANTHROPIC = config.anthropicApiKey;
      if (config.openaiApiKey) apiKeys.OPENAI = config.openaiApiKey;
      if (config.geminiApiKey) apiKeys.GEMINI = config.geminiApiKey;
      if (config.openrouterApiKey) apiKeys.OPENROUTER = config.openrouterApiKey;
      if (config.mistralApiKey) apiKeys.MISTRAL = config.mistralApiKey;
      if (config.cohereApiKey) apiKeys.COHERE = config.cohereApiKey;
      if (config.groqApiKey) apiKeys.GROQ = config.groqApiKey;
      if (config.perplexityApiKey) apiKeys.PERPLEXITY = config.perplexityApiKey;
      if (config.togetherApiKey) apiKeys.TOGETHER = config.togetherApiKey;
      if (config.deepseekApiKey) apiKeys.DEEPSEEK = config.deepseekApiKey;
      if (config.fireworksApiKey) apiKeys.FIREWORKS = config.fireworksApiKey;

      // Check if at least one API key is provided
      if (Object.keys(apiKeys).length === 0) {
        throw new HttpException(
          'At least one API key must be provided',
          HttpStatus.BAD_REQUEST
        );
      }

      await this.apiKeysService.saveApiKeys(apiKeys);
      
      return { 
        success: true, 
        message: "API keys saved successfully" 
      };
    } catch (error) {
      // Log sanitized error information without sensitive API keys
      this.logSanitizedError('save API keys', error);
      
      // Handle HttpExceptions (like validation errors) as-is
      if (error instanceof HttpException) {
        throw error;
      }
      
      // Handle typed application errors
      if (isAppError(error)) {
        throw new HttpException(error.message, error.statusCode);
      }
      
      // Handle specific custom error types
      if (error instanceof ValidationError) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      
      if (error instanceof DuplicateKeyError) {
        throw new HttpException(error.message, HttpStatus.CONFLICT);
      }
      
      if (error instanceof UnauthorizedError) {
        throw new HttpException(error.message, HttpStatus.UNAUTHORIZED);
      }
      
      if (error instanceof NotFoundError) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      
      // Fallback for unknown errors
      throw new HttpException('Failed to save API keys', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  async testApiKey(@Body() body: TestApiKeyDto) {
    try {
      const result = await this.apiKeysService.testApiKey(body.provider, body.apiKey);
      return result;
    } catch (error) {
      // Log sanitized error information with masked API key
      this.logSanitizedError('test API key', error, body.provider);
      // Additional logging with masked API key for this specific operation
      this.logger.error(`API key test failed for provider ${body.provider} with key ${this.maskApiKey(body.apiKey)}`);
      
      // Handle HttpExceptions as-is
      if (error instanceof HttpException) {
        throw error;
      }
      
      // Handle typed application errors
      if (isAppError(error)) {
        throw new HttpException(error.message, error.statusCode);
      }
      
      // Handle specific custom error types
      if (error instanceof ValidationError) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      
      if (error instanceof UnauthorizedError) {
        throw new HttpException(error.message, HttpStatus.UNAUTHORIZED);
      }
      
      if (error instanceof NotFoundError) {
        throw new HttpException(error.message, HttpStatus.NOT_FOUND);
      }
      
      if (error instanceof RateLimitError) {
        throw new HttpException(error.message, HttpStatus.TOO_MANY_REQUESTS);
      }
      
      if (error instanceof NetworkError) {
        throw new HttpException(error.message, HttpStatus.BAD_GATEWAY);
      }
      
      // Fallback for unknown errors
      throw new HttpException('Failed to test API key', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}