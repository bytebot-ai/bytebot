/**
 * Goal Run Controller
 * v1.0.0: REST API for Manus-style goal-first orchestration
 *
 * Endpoints:
 * - POST /api/v1/runs/from-goal - Create goal run
 * - GET /api/v1/goal-runs/:id - Get goal run
 * - GET /api/v1/goal-runs - List goal runs
 * - GET /api/v1/goal-runs/:id/plan - Get current plan
 * - GET /api/v1/goal-runs/:id/plan/history - Get plan history
 * - POST /api/v1/goal-runs/:id/steering - Send steering command
 * - GET /api/v1/goal-runs/:id/activity - Get activity feed
 * - POST /api/v1/goal-runs/:id/pause - Pause goal run
 * - POST /api/v1/goal-runs/:id/resume - Resume goal run
 * - POST /api/v1/goal-runs/:id/cancel - Cancel goal run
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
  BadRequestException,
  Headers,
} from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  IsEnum,
  MinLength,
} from 'class-validator';
import {
  GoalRunService,
  CreateGoalRunInput,
  GoalConstraints,
  SteeringInput,
  GoalRunFilters,
  GoalRunStatus,
  GoalRunPhase,
} from '../services/goal-run.service';
import { PlannerService } from '../services/planner.service';
import { OrchestratorLoopService } from '../services/orchestrator-loop.service';

// ============================================================================
// DTOs with class-validator decorators for ValidationPipe compatibility
// ============================================================================

/**
 * DTO for creating a new goal run
 */
class CreateGoalRunDto {
  @IsString()
  @MinLength(10, { message: 'Goal must be at least 10 characters' })
  goal!: string;

  @IsOptional()
  @IsObject()
  constraints?: GoalConstraints;

  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;
}

/**
 * Steering message types for goal run control
 */
enum SteeringMessageType {
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  CANCEL = 'CANCEL',
  MODIFY_PLAN = 'MODIFY_PLAN',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  INSTRUCTION = 'INSTRUCTION',
}

/**
 * DTO for sending steering commands to a goal run
 */
class SteeringMessageDto {
  @IsEnum(SteeringMessageType)
  type!: SteeringMessageType;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  targetItemId?: string;
}

/**
 * DTO for filtering goal runs list
 */
class GoalRunFiltersDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  phase?: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;
}

/**
 * DTO for pagination parameters
 */
class PaginationDto {
  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;
}

/**
 * DTO for cancelling a goal run
 */
class CancelGoalRunDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * DTO for estimating goal complexity
 */
class EstimateComplexityDto {
  @IsString()
  @MinLength(10, { message: 'Goal must be at least 10 characters' })
  goal!: string;
}

/**
 * DTO for rejecting a step
 */
class RejectStepDto {
  @IsString()
  reason!: string;
}

// v5.11.3: Removed deprecated api/v1 backward compatibility prefix (was scheduled for v5.6.0)
@Controller()
export class GoalRunController {
  constructor(
    private goalRunService: GoalRunService,
    private plannerService: PlannerService,
    private orchestratorLoopService: OrchestratorLoopService,
  ) {}

  /**
   * POST /api/v1/runs/from-goal
   * Create a new goal-based run
   * Rate limited: 5 per minute, 20 per hour per tenant (expensive operation)
   */
  @Post('runs/from-goal')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 goal runs per minute
  async createFromGoal(
    @Body() dto: CreateGoalRunDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!dto.goal || dto.goal.trim().length < 10) {
      throw new BadRequestException('Goal must be at least 10 characters');
    }

    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const input: CreateGoalRunInput = {
      tenantId,
      goal: dto.goal.trim(),
      constraints: dto.constraints,
      autoStart: dto.autoStart,
    };

    const goalRun = await this.goalRunService.createFromGoal(input);

    return {
      success: true,
      data: goalRun,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id
   * Get goal run by ID
   */
  @Get('goal-runs/:id')
  async getGoalRun(@Param('id') id: string) {
    const goalRun = await this.goalRunService.findByIdWithPlan(id);

    // Add loop status
    const loopStatus = this.orchestratorLoopService.getLoopStatus(id);

    return {
      success: true,
      data: {
        ...goalRun,
        loopStatus,
      },
    };
  }

  /**
   * GET /api/v1/goal-runs
   * List goal runs for tenant
   */
  @Get('goal-runs')
  async listGoalRuns(
    @Query() query: GoalRunFiltersDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const filters: GoalRunFilters = {
      status: query.status as GoalRunStatus | undefined,
      phase: query.phase as GoalRunPhase | undefined,
      page: query.page ? parseInt(query.page, 10) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 20,
    };

    const result = await this.goalRunService.findByTenant(tenantId, filters);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id/plan
   * Get current plan for goal run
   */
  @Get('goal-runs/:id/plan')
  async getCurrentPlan(@Param('id') id: string) {
    const plan = await this.goalRunService.getCurrentPlan(id);

    return {
      success: true,
      data: plan,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id/plan/history
   * Get plan version history
   */
  @Get('goal-runs/:id/plan/history')
  async getPlanHistory(@Param('id') id: string) {
    const history = await this.goalRunService.getPlanHistory(id);

    return {
      success: true,
      data: history,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id/plan/diff
   * Get diff between two plan versions
   */
  @Get('goal-runs/:id/plan/diff')
  async getPlanDiff(
    @Param('id') id: string,
    @Query('from') fromVersion: string,
    @Query('to') toVersion: string,
  ) {
    const history = await this.goalRunService.getPlanHistory(id);

    const fromPlan = history.find((p) => p.version === parseInt(fromVersion, 10));
    const toPlan = history.find((p) => p.version === parseInt(toVersion, 10));

    if (!fromPlan || !toPlan) {
      throw new BadRequestException('Invalid version numbers');
    }

    // Simple diff - compare items
    const addedItems = toPlan.items.filter(
      (toItem) => !fromPlan.items.some((fromItem) => fromItem.description === toItem.description),
    );
    const removedItems = fromPlan.items.filter(
      (fromItem) => !toPlan.items.some((toItem) => toItem.description === fromItem.description),
    );
    const unchangedItems = toPlan.items.filter((toItem) =>
      fromPlan.items.some((fromItem) => fromItem.description === toItem.description),
    );

    return {
      success: true,
      data: {
        fromVersion: parseInt(fromVersion, 10),
        toVersion: parseInt(toVersion, 10),
        replanReason: toPlan.replanReason,
        changes: {
          added: addedItems,
          removed: removedItems,
          unchanged: unchangedItems,
        },
      },
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/steering
   * Send steering command
   */
  @Post('goal-runs/:id/steering')
  @HttpCode(HttpStatus.OK)
  async sendSteering(
    @Param('id') id: string,
    @Body() dto: SteeringMessageDto,
    @Headers('x-user-id') userId?: string,
    @Headers('x-user-email') userEmail?: string,
  ) {
    const input: SteeringInput = {
      type: dto.type,
      content: dto.content,
      targetItemId: dto.targetItemId,
      userId,
      userEmail,
    };

    await this.goalRunService.submitSteering(id, input);

    return {
      success: true,
      message: `Steering command ${dto.type} sent`,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id/activity
   * Get activity feed
   */
  @Get('goal-runs/:id/activity')
  async getActivityFeed(@Param('id') id: string, @Query() query: PaginationDto) {
    const options = {
      page: query.page ? parseInt(query.page, 10) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 50,
    };

    const result = await this.goalRunService.getActivityFeed(id, options);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/pause
   * Pause goal run
   */
  @Post('goal-runs/:id/pause')
  @HttpCode(HttpStatus.OK)
  async pauseGoalRun(@Param('id') id: string) {
    const goalRun = await this.goalRunService.pauseGoalRun(id);

    return {
      success: true,
      data: goalRun,
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/resume
   * Resume goal run
   */
  @Post('goal-runs/:id/resume')
  @HttpCode(HttpStatus.OK)
  async resumeGoalRun(@Param('id') id: string) {
    const goalRun = await this.goalRunService.resumeGoalRun(id);

    return {
      success: true,
      data: goalRun,
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/cancel
   * Cancel goal run
   */
  @Post('goal-runs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelGoalRun(@Param('id') id: string, @Body() dto: CancelGoalRunDto) {
    const goalRun = await this.goalRunService.cancelGoalRun(id, dto?.reason);

    return {
      success: true,
      data: goalRun,
    };
  }

  /**
   * GET /api/v1/goal-runs/:id/metrics
   * Get goal run metrics
   */
  @Get('goal-runs/:id/metrics')
  async getMetrics(@Param('id') id: string) {
    const metrics = await this.goalRunService.getMetrics(id);

    return {
      success: true,
      data: metrics,
    };
  }

  /**
   * POST /api/v1/goals/estimate-complexity
   * Estimate complexity of a goal (preview before creating)
   * Rate limited: 10 per minute (AI operation)
   */
  @Post('goals/estimate-complexity')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 estimates per minute
  async estimateComplexity(@Body() dto: EstimateComplexityDto) {
    // DTO validation handles minimum length check
    const estimate = await this.plannerService.estimateComplexity(dto.goal);

    return {
      success: true,
      data: estimate,
    };
  }

  // ==========================================
  // Phase 4: Live Desktop Control APIs
  // ==========================================

  /**
   * POST /api/v1/goal-runs/:id/intervene
   * User takes control from agent
   */
  @Post('goal-runs/:id/intervene')
  @HttpCode(HttpStatus.OK)
  async intervene(
    @Param('id') id: string,
    @Headers('x-user-id') userId?: string,
  ) {
    const goalRun = await this.goalRunService.intervene(id, userId);

    return {
      success: true,
      data: goalRun,
      message: 'Control transferred to user',
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/return-control
   * User returns control to agent
   */
  @Post('goal-runs/:id/return-control')
  @HttpCode(HttpStatus.OK)
  async returnControl(
    @Param('id') id: string,
    @Headers('x-user-id') userId?: string,
  ) {
    const goalRun = await this.goalRunService.returnControl(id, userId);

    return {
      success: true,
      data: goalRun,
      message: 'Control returned to agent',
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/steps/:stepId/approve
   * Approve a step
   */
  @Post('goal-runs/:id/steps/:stepId/approve')
  @HttpCode(HttpStatus.OK)
  async approveStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Headers('x-user-id') userId?: string,
  ) {
    const step = await this.goalRunService.approveStep(id, stepId, userId);

    return {
      success: true,
      data: step,
      message: 'Step approved',
    };
  }

  /**
   * POST /api/v1/goal-runs/:id/steps/:stepId/reject
   * Reject a step with reason
   */
  @Post('goal-runs/:id/steps/:stepId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectStep(
    @Param('id') id: string,
    @Param('stepId') stepId: string,
    @Body() dto: RejectStepDto,
    @Headers('x-user-id') userId?: string,
  ) {
    // DTO validation handles required check via @IsString()
    const step = await this.goalRunService.rejectStep(id, stepId, dto.reason, userId);

    return {
      success: true,
      data: step,
      message: 'Step rejected',
    };
  }
}
