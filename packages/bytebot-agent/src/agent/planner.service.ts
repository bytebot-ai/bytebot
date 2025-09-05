import { Injectable, Logger } from '@nestjs/common';
import { AnthropicService } from '../anthropic/anthropic.service';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import { ProxyService } from '../proxy/proxy.service';
import { BytebotAgentModel, BytebotAgentService } from './agent.types';
import { PLANNING_SYSTEM_PROMPT } from './agent.constants';
import { Message, Task } from '@prisma/client';
import { MessageContentType } from '@bytebot/shared';

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);
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

  async generatePlan(task: Task, initialMessage: Message): Promise<string[]> {
    this.logger.log(`Generating plan for task ID: ${task.id}`);

    const model = task.model as unknown as BytebotAgentModel;
    const service = this.services[model.provider];

    if (!service) {
      this.logger.error(`No service found for model provider: ${model.provider}`);
      return [];
    }

    try {
        const response = await service.generateMessage(
            PLANNING_SYSTEM_PROMPT,
            [initialMessage],
            model.name,
            false, // No tools needed for planning
        );

        const planText = response.contentBlocks
            .filter(block => block.type === MessageContentType.Text)
            .map(block => block.text)
            .join('\n');

        if (!planText) {
            return [];
        }

        // Attempt to parse the plan as JSON, but fall back to a single step if it fails
        try {
            const plan = JSON.parse(planText);
            if (Array.isArray(plan) && plan.every(item => typeof item === 'string')) {
                this.logger.log(`Generated plan with ${plan.length} steps for task ID: ${task.id}`);
                return plan;
            } else {
                this.logger.warn(`Parsed plan is not an array of strings for task ID: ${task.id}.`);
                return [planText];
            }
        } catch (e) {
             this.logger.warn(`Failed to parse plan as JSON for task ID: ${task.id}. Using raw text as a single step. Raw output: ${planText}`);
             return [planText];
        }

    } catch (error) {
      this.logger.error(`Failed to generate plan for task ID: ${task.id}`, error.stack);
      return [];
    }
  }
}
