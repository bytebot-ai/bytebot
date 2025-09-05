import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '../anthropic/anthropic.service';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import { ProxyService } from '../proxy/proxy.service';
import { BytebotAgentModel, BytebotAgentService } from './agent.types';
import { REFLECTION_SYSTEM_PROMPT } from './agent.constants';
import { Message, Role, Task } from '@prisma/client';
import { MessageContentType } from '@bytebot/shared';

export interface Reflection {
    status: 'success' | 'failure' | 'retry';
    reason: string;
}

@Injectable()
export class ReflectorService {
  private readonly logger = new Logger(ReflectorService.name);
  private services: Record<string, BytebotAgentService> = {};

  constructor(
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly proxyService: ProxyService,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      proxy: this.proxyService,
    };
  }

  async reflectOnOutcome(task: Task, conversationHistory: Message[]): Promise<Reflection> {
    this.logger.log(`Reflecting on outcome for task ID: ${task.id}`);

    const model = task.model as unknown as BytebotAgentModel;
    const service = this.services[model.provider];

    if (!service) {
        const errorMessage = `No service found for model provider: ${model.provider}`;
        this.logger.error(errorMessage);
        return { status: 'failure', reason: errorMessage };
    }

    try {
        const response = await service.generateMessage(
            REFLECTION_SYSTEM_PROMPT,
            conversationHistory,
            model.name,
            false, // No tools needed for reflection
        );

        const reflectionText = response.contentBlocks
            .filter(block => block.type === MessageContentType.Text)
            .map(block => block.text)
            .join('\n');

        try {
            const reflection: Reflection = JSON.parse(reflectionText);
            // Basic validation
            if (['success', 'failure', 'retry'].includes(reflection.status) && typeof reflection.reason === 'string') {
                this.logger.log(`Reflection result for task ${task.id}: ${reflection.status} - ${reflection.reason}`);
                return reflection;
            }
            this.logger.warn(`Parsed reflection has invalid format for task ID: ${task.id}.`);
            return { status: 'retry', reason: 'Reflection output was malformed.' };
        } catch (e) {
             this.logger.warn(`Failed to parse reflection as JSON for task ID: ${task.id}. Raw output: ${reflectionText}`);
             return { status: 'retry', reason: 'Failed to parse reflection JSON.' };
        }

    } catch (error) {
      this.logger.error(`Failed to reflect on outcome for task ID: ${task.id}`, error.stack);
      return { status: 'failure', reason: 'An unexpected error occurred during reflection.' };
    }
  }
}
