import { Module } from '@nestjs/common';
import { ProviderManagerService } from './provider-manager.service';
import { ProvidersController } from './providers.controller';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { OpenAIModule } from '../openai/openai.module';
import { GoogleModule } from '../google/google.module';
import { OpenRouterModule } from '../openrouter/openrouter.module';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [
    AnthropicModule,
    OpenAIModule,
    GoogleModule,
    OpenRouterModule,
    ProxyModule,
  ],
  controllers: [ProvidersController],
  providers: [ProviderManagerService],
  exports: [ProviderManagerService],
})
export class ProvidersModule {}