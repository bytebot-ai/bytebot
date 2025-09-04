import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleService } from './google.service';

@Module({
  imports: [ConfigModule],
  providers: [GoogleService],
  exports: [GoogleService],
})
export class GoogleModule {}
