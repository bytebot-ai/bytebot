/**
 * Goal Run Module
 * v1.0.0: NestJS module for Manus-style goal-first orchestration
 *
 * Provides:
 * - GoalRunService - Goal run lifecycle management
 * - PlannerService - LLM-powered plan generation
 * - OrchestratorLoopService - PEVR loop execution
 * - GoalRunController - REST API endpoints
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';

// Services
import { GoalRunService } from '../services/goal-run.service';
import { PlannerService } from '../services/planner.service';
import { OrchestratorLoopService } from '../services/orchestrator-loop.service';
import { PrismaService } from '../services/prisma.service';
import { WorkflowService } from '../services/workflow.service';
import { WorkspaceService } from '../services/workspace.service';

// Controllers
import { GoalRunController } from '../controllers/goal-run.controller';

@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot(),
  ],
  controllers: [GoalRunController],
  providers: [
    GoalRunService,
    PlannerService,
    OrchestratorLoopService,
    PrismaService,
    WorkflowService,
    WorkspaceService,
  ],
  exports: [
    GoalRunService,
    PlannerService,
    OrchestratorLoopService,
  ],
})
export class GoalRunModule {}
