/**
 * Workflow Controller
 * v1.0.0: REST API for workflow management
 *
 * Endpoints:
 * - POST /workflows - Create a new workflow
 * - GET /workflows/:id - Get workflow status
 * - POST /workflows/:id/start - Start workflow execution
 * - POST /workflows/:id/cancel - Cancel workflow
 * - GET /workflows/:id/nodes - List workflow nodes
 * - GET /workflows/:id/nodes/:nodeId - Get node details
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { IsString, IsOptional, IsArray, IsObject, MinLength } from 'class-validator';
import { WorkflowService, CreateWorkflowInput } from '../services/workflow.service';

// ============================================================================
// DTOs with class-validator decorators for ValidationPipe compatibility
// ============================================================================

/**
 * DTO for creating a workflow
 */
class CreateWorkflowDto {
  @IsString()
  tenantId!: string;

  @IsString()
  @MinLength(3)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  nodes!: any[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

/**
 * DTO for cancelling a workflow
 */
class CancelWorkflowDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller('workflows')
export class WorkflowController {
  private readonly logger = new Logger(WorkflowController.name);

  constructor(private workflowService: WorkflowService) {}

  /**
   * POST /api/v1/workflows
   * Create a new workflow
   */
  @Post()
  async createWorkflow(@Body() dto: CreateWorkflowDto) {
    this.logger.log(`Creating workflow for tenant ${dto.tenantId}`);

    try {
      const input: CreateWorkflowInput = dto;
      const result = await this.workflowService.createWorkflow(input);
      return {
        success: true,
        workflow: result,
      };
    } catch (error: any) {
      this.logger.error(`Failed to create workflow: ${error.message}`);
      throw new HttpException(
        `Failed to create workflow: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /api/v1/workflows/:id
   * Get workflow details
   */
  @Get(':id')
  async getWorkflow(@Param('id') id: string) {
    const workflow = await this.workflowService.getWorkflow(id);

    if (!workflow) {
      throw new HttpException('Workflow not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      workflow,
    };
  }

  /**
   * POST /api/v1/workflows/:id/start
   * Start workflow execution
   */
  @Post(':id/start')
  async startWorkflow(@Param('id') id: string) {
    this.logger.log(`Starting workflow ${id}`);

    try {
      await this.workflowService.startWorkflow(id);
      return {
        success: true,
        message: 'Workflow started',
      };
    } catch (error: any) {
      this.logger.error(`Failed to start workflow: ${error.message}`);
      throw new HttpException(
        `Failed to start workflow: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /api/v1/workflows/:id/cancel
   * Cancel workflow execution
   */
  @Post(':id/cancel')
  async cancelWorkflow(
    @Param('id') id: string,
    @Body() dto: CancelWorkflowDto,
  ) {
    this.logger.log(`Cancelling workflow ${id}`);

    try {
      await this.workflowService.cancelWorkflow(id, dto.reason);
      return {
        success: true,
        message: 'Workflow cancelled',
      };
    } catch (error: any) {
      this.logger.error(`Failed to cancel workflow: ${error.message}`);
      throw new HttpException(
        `Failed to cancel workflow: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
