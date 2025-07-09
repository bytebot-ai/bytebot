import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LumenService } from './lumen.service';

@Module({
  imports: [ConfigModule],
  providers: [LumenService],
  exports: [LumenService],
})
export class LumenModule {}
