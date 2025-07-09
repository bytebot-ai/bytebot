import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GoogleService } from './google.service';
import { LumenModule } from '../lumen/lumen.module';

@Module({
  imports: [ConfigModule, LumenModule],
  providers: [GoogleService],
  exports: [GoogleService],
})
export class GoogleModule {}
