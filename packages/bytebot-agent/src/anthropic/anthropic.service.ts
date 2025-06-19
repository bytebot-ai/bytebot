import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
} from '@bytebot/shared';
import { AGENT_SYSTEM_PROMPT, DEFAULT_MODEL } from './anthropic.constants';
import { Message, Role } from '@prisma/client';
import { anthropicTools } from './anthropic.tools';

@Injectable()
export class AnthropicService {
  private readonly anthropic: Anthropic;
  private readonly logger = new Logger(AnthropicService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY is not set. AnthropicService will not work properly.',
      );
    }

    this.anthropic = new Anthropic({
      apiKey: apiKey || 'dummy-key-for-initialization',
    });
  }

  /**
   * Sends a message to Anthropic Claude and returns the response
   *
   * @param messages Array of message content blocks representing the conversation
   * @param selectedModel The LLM model to use for the request
   * @returns The AI response as an array of message content blocks
   */

  async sendMessage(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<MessageContentBlock[]> {
    try {
      const model = selectedModel || DEFAULT_MODEL;
      const maxTokens = 8192;

      // Convert our message content blocks to Anthropic's expected format
      const anthropicMessages = this.formatMessagesForAnthropic(messages);

      // add cache_control to last tool
      anthropicTools[anthropicTools.length - 1].cache_control = {
        type: 'ephemeral',
      };

      // Make the API call
      const response = await this.anthropic.beta.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: [
            {
              type: 'text',
              text: AGENT_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: anthropicMessages,
          tools: anthropicTools,
        },
        { signal },
      );

      // Convert Anthropic's response to our message content blocks format
      return this.formatAnthropicResponse(response.content);
    } catch (error) {
      this.logger.log(error);

      if (error instanceof APIUserAbortError) {
        this.logger.log('Anthropic API call aborted');
        const error = new Error('Anthropic API call aborted');
        error.name = 'AbortError';
        throw error;
      }
      this.logger.error(
        `Error sending message to Anthropic: ${error.message}`,
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

      // Don't include user messages that have tool use
      if (
        message.role === Role.USER &&
        messageContentBlocks.some(
          (block) => block.type === MessageContentType.ToolUse,
        )
      ) {
        continue;
      }

      const content: Anthropic.ContentBlockParam[] = messageContentBlocks.map(
        (block) => block as Anthropic.ContentBlockParam,
      );

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

        default:
          this.logger.warn(
            `Unknown content block type from Anthropic: ${block.type}`,
          );
          return {
            type: MessageContentType.Text,
            text: JSON.stringify(block),
          } as TextContentBlock;
      }
    });
  }
}
