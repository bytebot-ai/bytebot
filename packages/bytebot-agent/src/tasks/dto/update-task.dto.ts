import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TaskPriority, TaskStatus } from '@prisma/client';

export class UpdateTaskDto {
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  queuedAt?: Date;

  @IsOptional()
  executedAt?: Date;

  @IsOptional()
  completedAt?: Date;

  // v2.2.5: Error message for failed tasks
  @IsOptional()
  @IsString()
  error?: string;

  // v2.4.1: Task result/outcome data (JSON)
  // Stores the outcome description from the AI agent when task completes
  @IsOptional()
  result?: Record<string, any>;
}
