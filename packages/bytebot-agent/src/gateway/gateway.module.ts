/**
 * Gateway Module
 * v2.3.0 M4: Provides Butler Service Gateway integration for non-desktop tools
 */

import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GatewayService } from './gateway.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
