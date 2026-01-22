import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { TasksModule } from './tasks/tasks.module';
import { MessagesModule } from './messages/messages.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { OpenAIModule } from './openai/openai.module';
import { GoogleModule } from './google/google.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SummariesModule } from './summaries/summaries.modue';
import { ProxyModule } from './proxy/proxy.module';
import { LLMResilienceModule } from './llm-resilience/llm-resilience.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { GatewayModule } from './gateway/gateway.module';
import { ToolsModule } from './tools/tools.module';
import { MetricsModule } from './metrics/metrics.module';

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
    ProxyModule,
    LLMResilienceModule, // v2.5.0: Retry logic for LLM API calls
    PrismaModule,
    WorkspaceModule, // v2.3.0 M4: Workspace-aware desktop resolution and locking
    GatewayModule,   // v2.3.0 M4: Butler Service Gateway integration
    ToolsModule,     // v2.3.0 M4: Unified tool execution and routing
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
