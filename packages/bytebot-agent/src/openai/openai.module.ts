import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OpenAIService } from './openai.service';
import { LumenModule } from '../lumen/lumen.module';

@Module({
  imports: [ConfigModule, LumenModule],
  providers: [OpenAIService],
  exports: [OpenAIService],
})
export class OpenAIModule {}
