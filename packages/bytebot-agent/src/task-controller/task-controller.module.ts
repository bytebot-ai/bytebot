/**
 * Task Controller Client Module
 * Phase 6.4: Agent Integration
 *
 * Provides communication with the Task Controller service for:
 * - Per-task credential fetching
 * - Desktop URL discovery
 * - Heartbeat reporting
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TaskControllerService } from './task-controller.service';

@Module({
  imports: [ConfigModule],
  providers: [TaskControllerService],
  exports: [TaskControllerService],
})
export class TaskControllerModule {}
