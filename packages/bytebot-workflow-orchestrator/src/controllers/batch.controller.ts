/**
 * Batch Controller
 * Phase 7: Enhanced Features
 *
 * REST API endpoints for batch goal execution:
 * - Create and manage batches
 * - Start/stop batch execution
 * - Monitor batch progress
 * - Retry failed items
 */

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiHeader,
  ApiProperty,
} from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  IsArray,
  IsEnum,
  IsNumber,
  MinLength,
  Min,
  Max,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BatchService,
  CreateBatchInput,
  BatchGoalInput,
  BatchFilters,
} from '../services/batch.service';

// Execution mode enum for validation
enum BatchExecutionMode {
  PARALLEL = 'PARALLEL',
  SEQUENTIAL = 'SEQUENTIAL',
}

// ============================================================================
// DTOs with class-validator decorators for ValidationPipe compatibility
// ============================================================================

/**
 * DTO for a single goal in a batch
 */
class BatchGoalDto {
  @ApiProperty({
    required: false,
    description: 'Goal text (required if templateId not provided)',
    example: 'Deploy api-gateway to production using rolling strategy',
    minLength: 10,
  })
  @IsOptional()
  @IsString()
  @MinLength(10, { message: 'Goal must be at least 10 characters' })
  goal?: string;

  @ApiProperty({ required: false, description: 'Execution constraints for this goal' })
  @IsOptional()
  @IsObject()
  constraints?: any;

  @ApiProperty({ required: false, description: 'Template ID to use (alternative to goal text)' })
  @IsOptional()
  @IsString()
  templateId?: string;

  @ApiProperty({
    required: false,
    description: 'Variable values if using a template',
    example: { service_name: 'api-gateway', environment: 'production' },
  })
  @IsOptional()
  @IsObject()
  variableValues?: Record<string, string | number | boolean>;
}

/**
 * DTO for creating a new batch
 */
class CreateBatchDto {
  @ApiProperty({ description: 'Batch name', example: 'Weekly Deployment Batch', minLength: 3 })
  @IsString()
  @MinLength(3, { message: 'Batch name must be at least 3 characters' })
  name!: string;

  @ApiProperty({ required: false, description: 'Batch description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    required: false,
    enum: ['PARALLEL', 'SEQUENTIAL'],
    description: 'Execution mode',
    default: 'PARALLEL',
  })
  @IsOptional()
  @IsEnum(BatchExecutionMode)
  executionMode?: 'PARALLEL' | 'SEQUENTIAL';

  @ApiProperty({
    required: false,
    description: 'Maximum concurrent goal executions (for PARALLEL mode)',
    default: 5,
    minimum: 1,
    maximum: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  maxConcurrency?: number;

  @ApiProperty({
    required: false,
    description: 'Stop batch execution if any goal fails',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stopOnFailure?: boolean;

  @ApiProperty({ type: [BatchGoalDto], description: 'List of goals to execute', minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'Batch must contain at least one goal' })
  @ValidateNested({ each: true })
  @Type(() => BatchGoalDto)
  goals!: BatchGoalDto[];
}

/**
 * DTO for filtering batch list
 */
class BatchFiltersDto {
  @ApiProperty({ required: false, description: 'Filter by batch status' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiProperty({ required: false, description: 'Page number', default: '1' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiProperty({ required: false, description: 'Page size', default: '20' })
  @IsOptional()
  @IsString()
  pageSize?: string;
}

@ApiTags('batches')
// v5.11.3: Removed deprecated api/v1/batches backward compatibility prefix (was scheduled for v5.6.0)
@Controller('batches')
export class BatchController {
  constructor(private batchService: BatchService) {}

  /**
   * POST /api/v1/batches
   * Create a new batch
   * Rate limited: 3 per minute (batch creation is resource-intensive)
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({
    summary: 'Create a new batch',
    description: 'Creates a batch of goals for parallel or sequential execution. Rate limited to 3 requests per minute.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 201, description: 'Batch created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async createBatch(
    @Body() dto: CreateBatchDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.name || dto.name.trim().length < 3) {
      throw new BadRequestException('Batch name must be at least 3 characters');
    }

    if (!dto.goals || dto.goals.length === 0) {
      throw new BadRequestException('Batch must contain at least one goal');
    }

    // Validate goals
    for (let i = 0; i < dto.goals.length; i++) {
      const goal = dto.goals[i];
      if (!goal.templateId && (!goal.goal || goal.goal.trim().length < 10)) {
        throw new BadRequestException(
          `Goal ${i + 1} must be at least 10 characters or specify a templateId`,
        );
      }
    }

    const goals: BatchGoalInput[] = dto.goals.map((g) => ({
      goal: g.goal || '', // Will be populated from template if templateId is provided
      constraints: g.constraints,
      templateId: g.templateId,
      variableValues: g.variableValues,
    }));

    const input: CreateBatchInput = {
      tenantId,
      name: dto.name.trim(),
      description: dto.description,
      executionMode: dto.executionMode,
      maxConcurrency: dto.maxConcurrency,
      stopOnFailure: dto.stopOnFailure,
      goals,
    };

    const batch = await this.batchService.create(input);

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * GET /api/v1/batches
   * List batches for tenant
   */
  @Get()
  @ApiOperation({ summary: 'List batches', description: 'Returns paginated list of batches for the tenant.' })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Batches retrieved successfully' })
  async listBatches(
    @Query() query: BatchFiltersDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const filters: BatchFilters = {
      status: query.status,
      page: query.page ? parseInt(query.page, 10) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 20,
    };

    const result = await this.batchService.findByTenant(tenantId, filters);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * GET /api/v1/batches/:id
   * Get batch by ID
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get batch by ID', description: 'Returns a batch with all its goal items.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Batch retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async getBatch(@Param('id') id: string) {
    const batch = await this.batchService.findByIdWithItems(id);

    return {
      success: true,
      data: batch,
    };
  }

  /**
   * GET /api/v1/batches/:id/items
   * Get batch items
   */
  @Get(':id/items')
  @ApiOperation({ summary: 'Get batch items', description: 'Returns all goal items in the batch.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Items retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async getBatchItems(@Param('id') id: string) {
    const batch = await this.batchService.findByIdWithItems(id);

    return {
      success: true,
      data: batch.items,
    };
  }

  /**
   * GET /api/v1/batches/:id/items/:itemId
   * Get specific batch item
   */
  @Get(':id/items/:itemId')
  @ApiOperation({ summary: 'Get batch item', description: 'Returns a specific goal item from the batch.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiParam({ name: 'itemId', description: 'Batch item ID' })
  @ApiResponse({ status: 200, description: 'Item retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Batch or item not found' })
  async getBatchItem(
    @Param('id') batchId: string,
    @Param('itemId') itemId: string,
  ) {
    const item = await this.batchService.getItem(batchId, itemId);

    return {
      success: true,
      data: item,
    };
  }

  /**
   * POST /api/v1/batches/:id/start
   * Start batch execution
   */
  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start batch execution', description: 'Starts executing all goals in the batch according to the configured execution mode.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Batch execution started' })
  @ApiResponse({ status: 400, description: 'Batch already started or completed' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async startBatch(@Param('id') id: string) {
    const batch = await this.batchService.start(id);

    return {
      success: true,
      data: batch,
      message: 'Batch execution started',
    };
  }

  /**
   * POST /api/v1/batches/:id/cancel
   * Cancel batch execution
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel batch execution', description: 'Cancels batch execution and marks pending items as cancelled.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Batch execution cancelled' })
  @ApiResponse({ status: 400, description: 'Batch not running' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async cancelBatch(
    @Param('id') id: string,
    @Body() body?: { reason?: string },
  ) {
    const batch = await this.batchService.cancel(id, body?.reason);

    return {
      success: true,
      data: batch,
      message: 'Batch execution cancelled',
    };
  }

  /**
   * POST /api/v1/batches/:id/retry
   * Retry failed items in batch
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Retry failed items', description: 'Retries all failed goal items in the batch.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Retry initiated successfully' })
  @ApiResponse({ status: 400, description: 'No failed items to retry' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async retryBatch(@Param('id') id: string) {
    const batch = await this.batchService.retryFailed(id);

    return {
      success: true,
      data: batch,
      message: 'Retrying failed items',
    };
  }

  /**
   * GET /api/v1/batches/:id/progress
   * Get batch progress summary
   */
  @Get(':id/progress')
  @ApiOperation({ summary: 'Get batch progress', description: 'Returns execution progress summary for the batch.' })
  @ApiParam({ name: 'id', description: 'Batch ID' })
  @ApiResponse({ status: 200, description: 'Progress retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async getBatchProgress(@Param('id') id: string) {
    const batch = await this.batchService.findById(id);

    return {
      success: true,
      data: {
        status: batch.status,
        progress: batch.progress,
        totalGoals: batch.totalGoals,
        completedGoals: batch.completedGoals,
        failedGoals: batch.failedGoals,
        cancelledGoals: batch.cancelledGoals,
        remainingGoals:
          batch.totalGoals -
          batch.completedGoals -
          batch.failedGoals -
          batch.cancelledGoals,
        startedAt: batch.startedAt,
        completedAt: batch.completedAt,
      },
    };
  }
}
