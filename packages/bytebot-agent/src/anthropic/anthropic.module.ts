import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnthropicService } from './anthropic.service';
import { LumenModule } from '../lumen/lumen.module';

@Module({
  imports: [ConfigModule, LumenModule],
  providers: [AnthropicService],
  exports: [AnthropicService],
})
export class AnthropicModule {}
