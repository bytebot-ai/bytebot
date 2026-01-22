/**
 * Workspace Module
 * v2.3.0 M4: Provides workspace-aware desktop resolution and granular locking
 */

import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WorkspaceService } from './workspace.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
