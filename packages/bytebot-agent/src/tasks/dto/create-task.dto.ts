import {
  IsArray,
  IsBoolean,
  IsDate,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ExecutionSurface, Role, TaskPriority, TaskType } from '@prisma/client';

export class TaskFileDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  base64: string;

  @IsNotEmpty()
  @IsString()
  type: string;

  @IsNotEmpty()
  @IsNumber()
  size: number;
}

export class CreateTaskDto {
  @IsNotEmpty()
  @IsString()
  description: string;

  // v2.2.16: Optional title - if not provided, will be AI-generated
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  type?: TaskType;

  @IsOptional()
  @IsDate()
  scheduledFor?: Date;

  @IsOptional()
  @IsString()
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  createdBy?: Role;

  @IsOptional()
  model?: any;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskFileDto)
  files?: TaskFileDto[];

  // v2.3.0 M4: Workflow context (null for Product 1 Tasks, set for Product 2 Workflows)
  // These are passed by the workflow orchestrator when dispatching a node run

  @IsOptional()
  @IsString()
  workspaceId?: string;

  @IsOptional()
  @IsString()
  nodeRunId?: string;

  // v2.3.0 M4: Tool configuration from workflow node definition
  // Controls which tools are available for this task

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedTools?: string[];

  @IsOptional()
  @IsBoolean()
  gatewayToolsOnly?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  highRiskTools?: string[];

  // Phase 4: Execution surface constraint - task requires desktop environment
  // If true, task MUST have a valid desktop pod before executing desktop tools
  @IsOptional()
  @IsBoolean()
  requiresDesktop?: boolean;

  // PR5: Explicit execution surface (TEXT_ONLY vs DESKTOP)
  @IsOptional()
  @IsEnum(ExecutionSurface)
  executionSurface?: ExecutionSurface;

  // v2.4.0: Context propagation for autonomous operation
  // When task is part of a multi-step goal, these fields provide context
  // to help the AI agent understand the broader context and proceed autonomously

  // Original goal/objective that this task is part of
  // Helps agent understand the overall intent without asking for clarification
  @IsOptional()
  @IsString()
  goalContext?: string;

  // Summary of what previous steps accomplished
  // Provides continuity between steps in a multi-step goal
  @IsOptional()
  @IsString()
  previousStepResults?: string;
}
