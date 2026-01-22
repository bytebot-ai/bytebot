import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
  ThinkingContentBlock,
  RedactedThinkingContentBlock,
  isUserActionContentBlock,
  isComputerToolUseContentBlock,
} from '@bytebot/shared';
import { DEFAULT_MODEL } from './anthropic.constants';
import { Message, Role } from '@prisma/client';
import { anthropicTools } from './anthropic.tools';
import {
  BytebotAgentService,
  BytebotAgentGenerateMessageOptions,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';
import { filterToolsByPolicy } from '../agent/tool-policy';

@Injectable()
export class AnthropicService implements BytebotAgentService {
  private readonly anthropic: Anthropic;
  private readonly logger = new Logger(AnthropicService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set. AnthropicService will not work properly.',
      );
    }

    // v2.2.8: Re-enable SDK retries for transient error resilience.
    // The SDK retries connection errors, 408, 409, 429, and 5xx with exponential backoff.
    // Duplicate responses are handled by the idempotency check in MessagesService.create()
    // which detects duplicate tool_use IDs before persisting to database.
    // See: 2025-12-09-race-condition-duplicate-llm-calls-fix.md
    this.anthropic = new Anthropic({
      apiKey: apiKey || 'dummy-key-for-initialization',
      maxRetries: 2, // SDK default: 2 retries with exponential backoff
    });

    this.logger.log('AnthropicService initialized with maxRetries: 2');
  }

  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string = DEFAULT_MODEL.name,
    options: BytebotAgentGenerateMessageOptions = {},
  ): Promise<BytebotAgentResponse> {
    const useTools = options.useTools ?? true;
    const signal = options.signal;

    // v2.2.7: Generate unique request ID for tracing
    const requestId = `llm-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const startTime = Date.now();

    try {
      const maxTokens = 8192;

      // Convert our message content blocks to Anthropic's expected format
      const anthropicMessages = this.formatMessagesForAnthropic(messages);

      const tools = useTools
        ? filterToolsByPolicy(
            anthropicTools.map((tool) => ({ ...tool })),
            (tool) => tool.name,
            options.toolPolicy,
          )
        : [];

      // Add cache_control to the last tool (best-effort, do not mutate shared definitions)
      if (tools.length > 0) {
        (tools[tools.length - 1] as any).cache_control = { type: 'ephemeral' };
      }

      // v2.2.7: Log before LLM call for debugging duplicate call issues
      this.logger.debug(
        `[${requestId}] Starting LLM call: model=${model}, messages=${messages.length}, useTools=${useTools}`,
      );

      // Make the API call
      const response = await this.anthropic.messages.create(
        {
          model,
          max_tokens: maxTokens * 2,
          thinking: { type: 'disabled' },
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: anthropicMessages,
          tools,
        },
        { signal },
      );

      const elapsed = Date.now() - startTime;

      // v2.2.7: Log response details for debugging
      // Extract tool_use IDs if present for tracking
      const toolUseIds = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block: any) => block.id);

      this.logger.debug(
        `[${requestId}] LLM call completed: elapsed=${elapsed}ms, blocks=${response.content.length}, toolUseIds=[${toolUseIds.join(', ')}]`,
      );

      // Convert Anthropic's response to our message content blocks format
      return {
        contentBlocks: this.formatAnthropicResponse(response.content),
        tokenUsage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.warn(
        `[${requestId}] LLM call failed after ${elapsed}ms: ${error.message}`,
      );

      if (error instanceof APIUserAbortError) {
        this.logger.log(`[${requestId}] Anthropic API call aborted`);
        throw new BytebotAgentInterrupt();
      }
      this.logger.error(
        `[${requestId}] Error sending message to Anthropic: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Convert our MessageContentBlock format to Anthropic's message format
   */
  private formatMessagesForAnthropic(
    messages: Message[],
  ): Anthropic.MessageParam[] {
    const anthropicMessages: Anthropic.MessageParam[] = [];

    // Process each message content block
    for (const [index, message] of messages.entries()) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      const content: Anthropic.ContentBlockParam[] = [];

      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionContentBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );
        for (const block of userActionContentBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            content.push({
              type: 'text',
              text: `User performed action: ${block.name}\n${JSON.stringify(block.input, null, 2)}`,
            });
          } else {
            content.push(block as Anthropic.ContentBlockParam);
          }
        }
      } else {
        content.push(
          ...messageContentBlocks.map(
            (block) => block as Anthropic.ContentBlockParam,
          ),
        );
      }

      if (index === messages.length - 1) {
        content[content.length - 1]['cache_control'] = {
          type: 'ephemeral',
        };
      }
      anthropicMessages.push({
        role: message.role === Role.USER ? 'user' : 'assistant',
        content: content,
      });
    }

    return anthropicMessages;
  }

  /**
   * Convert Anthropic's response content to our MessageContentBlock format
   */
  private formatAnthropicResponse(
    content: Anthropic.ContentBlock[],
  ): MessageContentBlock[] {
    return content.map((block) => {
      switch (block.type) {
        case 'text':
          return {
            type: MessageContentType.Text,
            text: block.text,
          } as TextContentBlock;

        case 'tool_use':
          return {
            type: MessageContentType.ToolUse,
            id: block.id,
            name: block.name,
            input: block.input,
          } as ToolUseContentBlock;

        case 'thinking':
          return {
            type: MessageContentType.Thinking,
            thinking: block.thinking,
            signature: block.signature,
          } as ThinkingContentBlock;

        case 'redacted_thinking':
          return {
            type: MessageContentType.RedactedThinking,
            data: block.data,
          } as RedactedThinkingContentBlock;
      }
    });
  }
}
