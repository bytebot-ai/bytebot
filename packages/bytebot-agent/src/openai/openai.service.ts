import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
} from '@bytebot/shared';
import { AGENT_SYSTEM_PROMPT, DEFAULT_MODEL } from './openai.constants';
import { Message, Role } from '@prisma/client';
import { openaiTools } from './openai.tools';

@Injectable()
export class OpenAIService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(OpenAIService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'OPENAI_API_KEY is not set. OpenAIService will not work properly.',
      );
    }

    this.openai = new OpenAI({
      apiKey: apiKey || 'dummy-key-for-initialization',
    });
  }

  async sendMessage(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<MessageContentBlock[]> {
    try {
      const model = DEFAULT_MODEL;
      const maxTokens = 8192;

      const openaiMessages = this.formatMessagesForOpenAI(messages);

      const response = await this.openai.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: AGENT_SYSTEM_PROMPT },
            ...openaiMessages,
          ],
          tools: openaiTools,
        },
        { signal },
      );

      return this.formatOpenAIResponse(response.choices[0].message);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.logger.log('OpenAI API call aborted');
        throw error;
      }
      this.logger.error(
        `Error sending message to OpenAI: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  private formatMessagesForOpenAI(
    messages: Message[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

    for (const message of messages) {
      const blocks = message.content as MessageContentBlock[];

      if (
        message.role === Role.USER &&
        blocks.some((b) => b.type === MessageContentType.ToolUse)
      ) {
        continue;
      }

      if (
        message.role === Role.USER &&
        blocks.every((b) => b.type === MessageContentType.ToolResult)
      ) {
        for (const block of blocks) {
          if (block.type !== MessageContentType.ToolResult) continue;
          const content = this.blocksToParts(block.content);
          openaiMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content,
          });
        }
        continue;
      }

      const role = message.role === Role.USER ? 'user' : 'assistant';
      const contentParts = this.blocksToParts(
        blocks.filter((b) => b.type !== MessageContentType.ToolUse),
      );
      const toolCalls = blocks
        .filter((b) => b.type === MessageContentType.ToolUse)
        .map((b) => ({
          id: (b as ToolUseContentBlock).id,
          type: 'function' as const,
          function: {
            name: (b as ToolUseContentBlock).name,
            arguments: JSON.stringify((b as ToolUseContentBlock).input ?? {}),
          },
        }));

      openaiMessages.push({
        role,
        content: contentParts.length > 0 ? contentParts : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }

    return openaiMessages;
  }

  private blocksToParts(
    blocks: MessageContentBlock[],
  ): OpenAI.ChatCompletionContentPart[] {
    const parts: OpenAI.ChatCompletionContentPart[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case MessageContentType.Text:
          parts.push({ type: 'text', text: block.text });
          break;
        case MessageContentType.Image:
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          });
          break;
        case MessageContentType.ToolResult:
          const text = block.content
            .map((b) =>
              b.type === MessageContentType.Text ? b.text : JSON.stringify(b),
            )
            .join('\n');
          parts.push({ type: 'text', text });
          break;
      }
    }

    return parts;
  }

  private formatOpenAIResponse(
    message: OpenAI.ChatCompletionMessage,
  ): MessageContentBlock[] {
    const blocks: MessageContentBlock[] = [];

    const content = message.content;
    if (typeof content === 'string') {
      if (content.trim().length > 0) {
        blocks.push({ type: MessageContentType.Text, text: content });
      }
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          blocks.push({ type: MessageContentType.Text, text: part.text });
        } else if (part.type === 'image_url') {
          blocks.push({
            type: MessageContentType.Image,
            source: {
              data: part.image_url.url.replace(/^data:image\/png;base64,/, ''),
              media_type: 'image/png',
              type: 'base64',
            },
          });
        }
      }
    }

    if ('tool_calls' in message && message.tool_calls) {
      for (const call of message.tool_calls) {
        blocks.push({
          type: MessageContentType.ToolUse,
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}'),
        } as ToolUseContentBlock);
      }
    }

    return blocks;
  }
}
