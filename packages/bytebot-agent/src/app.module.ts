import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { TasksModule } from './tasks/tasks.module';
import { MessagesModule } from './messages/messages.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { OpenAIModule } from './openai/openai.module';
import { GoogleModule } from './google/google.module';
import { OpenRouterModule } from './openrouter/openrouter.module';
import { ProvidersModule } from './providers/providers.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SummariesModule } from './summaries/summaries.module';
import { ProxyModule } from './proxy/proxy.module';
import { ApiKeysModule } from './api-keys/api-keys.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AgentModule,
    TasksModule,
    MessagesModule,
    SummariesModule,
    AnthropicModule,
    OpenAIModule,
    GoogleModule,
    OpenRouterModule,
    ProvidersModule,
    ProxyModule,
    PrismaModule,
    ApiKeysModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
