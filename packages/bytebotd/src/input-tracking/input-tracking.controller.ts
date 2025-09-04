import { Controller, Post } from '@nestjs/common';
import { InputTrackingService } from './input-tracking.service';

@Controller('input-tracking')
export class InputTrackingController {
  constructor(private readonly inputTrackingService: InputTrackingService) {}

  @Post('start')
  start() {
    this.inputTrackingService.startTracking();
    return { status: 'started' };
  }

  @Post('stop')
  stop() {
    this.inputTrackingService.stopTracking();
    return { status: 'stopped' };
  }
}
