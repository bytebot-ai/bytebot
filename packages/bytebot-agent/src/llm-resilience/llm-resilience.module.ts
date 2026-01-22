/**
 * LLM Resilience Module
 *
 * Provides retry logic, circuit breaker, and error classification
 * for all LLM API calls in the bytebot-agent.
 */

import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { LLMResilienceService } from './llm-resilience.service';

@Global()
@Module({
  imports: [ConfigModule, EventEmitterModule],
  providers: [LLMResilienceService],
  exports: [LLMResilienceService],
})
export class LLMResilienceModule {}
