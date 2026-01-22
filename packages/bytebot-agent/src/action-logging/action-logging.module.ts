/**
 * Action Logging Module
 * Phase 6.4: Agent Integration
 *
 * Provides action logging to the Desktop Router for audit and retraining.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActionLoggingService } from './action-logging.service';
import { TaskControllerModule } from '../task-controller/task-controller.module';

@Module({
  imports: [ConfigModule, TaskControllerModule],
  providers: [ActionLoggingService],
  exports: [ActionLoggingService],
})
export class ActionLoggingModule {}
