import { Module } from '@nestjs/common';
import { InputTrackingService } from './input-tracking.service';
import { InputTrackingController } from './input-tracking.controller';
import { InputTrackingGateway } from './input-tracking.gateway';
import { ComputerUseModule } from '../computer-use/computer-use.module';

@Module({
  imports: [ComputerUseModule],
  controllers: [InputTrackingController],
  providers: [InputTrackingService, InputTrackingGateway],
  exports: [InputTrackingService, InputTrackingGateway],
})
export class InputTrackingModule {}
