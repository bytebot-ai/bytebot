import { BadRequestException, Controller, Get, Headers, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { OutboxService } from '../services/outbox.service';

class ReplayEventsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsString()
  eventType?: string;
}

@Controller()
export class EventsController {
  constructor(private readonly outboxService: OutboxService) {}

  /**
   * GET /api/v1/events?cursor=&limit=
   * Cursor-based replay of outbox events for a tenant (monotonic eventSequence).
   */
  @Get('events')
  @HttpCode(HttpStatus.OK)
  async replay(
    @Query() query: ReplayEventsQueryDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    let cursor: bigint | undefined;
    if (query.cursor !== undefined) {
      try {
        cursor = BigInt(query.cursor);
        if (cursor < 0n) throw new Error('cursor must be >= 0');
      } catch {
        throw new BadRequestException('cursor must be an integer string (>= 0)');
      }
    }

    const result = await this.outboxService.replayEvents({
      tenantId,
      cursor,
      limit: query.limit,
      eventType: query.eventType,
    });

    return {
      success: true,
      data: result,
    };
  }
}

