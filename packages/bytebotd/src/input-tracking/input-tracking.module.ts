import { Module } from '@nestjs/common';
import { InputTrackingService } from './input-tracking.service';

@Module({
  providers: [InputTrackingService],
  exports: [InputTrackingService],
})
export class InputTrackingModule {}
