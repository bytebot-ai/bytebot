import { IsEnum, IsOptional } from 'class-validator';
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
}
