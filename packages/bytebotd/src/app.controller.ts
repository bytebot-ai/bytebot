import { Controller, Get, Redirect, Headers } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // When a client makes a GET request to /vnc,
  // this method will automatically redirect them to the noVNC URL.
  @Get('vnc')
  // Leave the decorator empty but keep the status code.
  @Redirect(undefined, 302)
  redirectToVnc(@Headers('host') host: string) {
    return {
      url: `/novnc/vnc.html?host=${host}&path=websockify&resize=scale`,
    };
  }
}
