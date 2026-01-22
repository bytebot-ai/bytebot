import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, BadRequestException, Headers, Query, Req } from '@nestjs/common';
import { IsEnum, IsInt, IsObject, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ActorType, UserPromptKind, UserPromptScope, UserPromptStatus } from '@prisma/client';
import { UserPromptResolutionService } from '../services/user-prompt-resolution.service';
import { UserPromptService } from '../services/user-prompt.service';
import type { Request } from 'express';

class PromptActorDto {
  @IsEnum(ActorType)
  type!: ActorType;

  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  authContext?: Record<string, any>;
}

class ResolveUserPromptDto {
  @ValidateNested()
  @Type(() => PromptActorDto)
  actor!: PromptActorDto;

  @IsObject()
  answers!: Record<string, any>;
}

class ListUserPromptsQueryDto {
  @IsOptional()
  @IsString()
  goalRunId?: string;

  @IsOptional()
  @IsEnum(UserPromptStatus)
  status?: UserPromptStatus;

  @IsOptional()
  @IsEnum(UserPromptKind)
  kind?: UserPromptKind;

  @IsOptional()
  @IsEnum(UserPromptScope)
  scope?: UserPromptScope;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller()
export class UserPromptController {
  constructor(
    private readonly userPromptResolutionService: UserPromptResolutionService,
    private readonly userPromptService: UserPromptService,
  ) {}

  /**
   * GET /api/v1/user-prompts
   * List prompts for a tenant (default limit=50). Answers are not returned.
   */
  @Get('user-prompts')
  @HttpCode(HttpStatus.OK)
  async listPrompts(
    @Query() query: ListUserPromptsQueryDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const prompts = await this.userPromptService.listUserPrompts({
      tenantId,
      goalRunId: query.goalRunId,
      status: query.status,
      kind: query.kind,
      scope: query.scope,
      limit: query.limit,
    });

    return {
      success: true,
      data: {
        prompts,
      },
    };
  }

  /**
   * POST /api/v1/user-prompts/:promptId/resolve
   * Resolve an OPEN prompt (idempotent).
   */
  @Post('user-prompts/:promptId/resolve')
  @HttpCode(HttpStatus.OK)
  async resolvePrompt(
    @Param('promptId') promptId: string,
    @Body() dto: ResolveUserPromptDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Req() req?: Request,
  ) {
    if (!promptId) {
      throw new BadRequestException('promptId is required');
    }
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }
    if (!dto?.actor || typeof dto.actor !== 'object') {
      throw new BadRequestException('actor is required');
    }
    if (!dto?.answers || typeof dto.answers !== 'object') {
      throw new BadRequestException('answers must be an object');
    }

    const result = await this.userPromptResolutionService.resolvePrompt({
      promptId,
      tenantId,
      actor: dto.actor,
      answers: dto.answers,
      requestId: (req?.headers?.['x-request-id'] as string | undefined) ?? undefined,
      clientRequestId: (req?.headers?.['x-client-request-id'] as string | undefined) ?? undefined,
      idempotencyKey:
        (req?.headers?.['idempotency-key'] as string | undefined) ??
        (req?.headers?.['x-idempotency-key'] as string | undefined) ??
        undefined,
      ipAddress: req?.ip,
      userAgent: (req?.headers?.['user-agent'] as string | undefined) ?? undefined,
    });

    return {
      success: true,
      data: result,
    };
  }
}
