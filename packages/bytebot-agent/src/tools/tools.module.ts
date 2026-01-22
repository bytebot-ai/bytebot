/**
 * Tools Module
 * v2.3.0 M4: Provides unified tool execution with routing between desktop and gateway
 */

import { Module, Global } from '@nestjs/common';
import { ToolExecutorService } from './tool-executor.service';
import { GatewayModule } from '../gateway/gateway.module';
import { WorkspaceModule } from '../workspace/workspace.module';

@Global()
@Module({
  imports: [GatewayModule, WorkspaceModule],
  providers: [ToolExecutorService],
  exports: [ToolExecutorService],
})
export class ToolsModule {}
