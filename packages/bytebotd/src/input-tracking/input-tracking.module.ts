import { Module } from '@nestjs/common';
import { InputTrackingService } from './input-tracking.service';
import { InputTrackingController } from './input-tracking.controller';
import { InputTrackingGateway } from './input-tracking.gateway';

@Module({
  controllers: [InputTrackingController],
  providers: [InputTrackingService, InputTrackingGateway],
  exports: [InputTrackingService, InputTrackingGateway],
})
export class InputTrackingModule {}
