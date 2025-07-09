import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
} from '@bytebot/shared';
import {
  AGENT_SYSTEM_PROMPT,
  BytebotAgentInterrupt,
} from '../agent/agent.constants';
import { Message, Role } from '@prisma/client';
import { googleTools } from './google.tools';
import {
  Content,
  GenerateContentResponse,
  GoogleGenAI,
  Part,
} from '@google/genai';
import { v4 as uuid } from 'uuid';
import { DEFAULT_MODEL } from './google.constants';

@Injectable()
export class GoogleService {
  private readonly google: GoogleGenAI;
  private readonly logger = new Logger(GoogleService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('GOOGLE_API_KEY');

    if (!apiKey) {
      this.logger.warn(
        'GOOGLE_API_KEY is not set. GoogleService will not work properly.',
      );
    }

    this.google = new GoogleGenAI({
      apiKey: apiKey || 'dummy-key-for-initialization',
    });
  }

  /**
   * Sends a message to Google Gemini and returns the response
   *
   * @param messages Array of message content blocks representing the conversation
   * @param options Additional options for the API call
   * @returns The AI response as an array of message content blocks
   */
  async sendMessage(
    messages: Message[],
    model: string = DEFAULT_MODEL.name,
    signal?: AbortSignal,
  ): Promise<MessageContentBlock[]> {
    try {
      const maxTokens = 8192;

      // Convert our message content blocks to Anthropic's expected format
      const googleMessages = this.formatMessagesForGoogle(messages);

      const response: GenerateContentResponse =
        await this.google.models.generateContent({
          model,
          contents: googleMessages,
          config: {
            maxOutputTokens: maxTokens,
            systemInstruction: AGENT_SYSTEM_PROMPT,
            tools: [
              {
                functionDeclarations: googleTools,
              },
            ],
            abortSignal: signal,
          },
        });

      // Log usage information
      if (response.usageMetadata) {
        this.logger.log(`Google Gemini usage: ${JSON.stringify(response.usageMetadata, null, 2)}`);
      }

      const candidate = response.candidates?.[0];

      if (!candidate) {
        throw new Error('No candidate found in response');
      }

      const content = candidate.content;

      if (!content) {
        throw new Error('No content found in candidate');
      }

      if (!content.parts) {
        throw new Error('No parts found in content');
      }

      return this.formatGoogleResponse(content.parts);
    } catch (error) {
      if (error.message.includes('AbortError')) {
        throw new BytebotAgentInterrupt();
      }
      this.logger.error(
        `Error sending message to Google Gemini: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Convert our MessageContentBlock format to Google Gemini's message format
   */
  private formatMessagesForGoogle(messages: Message[]): Content[] {
    const googleMessages: Content[] = [];

    // Process each message content block
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      const parts: Part[] = [];

      for (const block of messageContentBlocks) {
        switch (block.type) {
          case MessageContentType.Text:
            parts.push({
              text: block.text,
            });
            break;
          case MessageContentType.ToolUse:
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args: block.input,
              },
            });
            break;
          case MessageContentType.Image:
            parts.push({
              inlineData: {
                data: block.source.data,
                mimeType: block.source.media_type,
              },
            });
            break;
          case MessageContentType.ToolResult: {
            const toolResultContentBlock = block.content[0];
            if (toolResultContentBlock.type === MessageContentType.Image) {
              parts.push({
                functionResponse: {
                  id: block.tool_use_id,
                  name: 'screenshot',
                  response: {
                    ...(!block.is_error && { output: 'screenshot successful' }),
                    ...(block.is_error && { error: block.content[0] }),
                  },
                },
              });
              parts.push({
                inlineData: {
                  data: toolResultContentBlock.source.data,
                  mimeType: toolResultContentBlock.source.media_type,
                },
              });
              break;
            }

            parts.push({
              functionResponse: {
                id: block.tool_use_id,
                name: this.getToolName(block.tool_use_id, messages),
                response: {
                  ...(!block.is_error && { output: block.content[0] }),
                  ...(block.is_error && { error: block.content[0] }),
                },
              },
            });
            break;
          }
          default:
            parts.push({
              text: JSON.stringify(block),
            });
            break;
        }
      }

      googleMessages.push({
        role: message.role === Role.USER ? 'user' : 'model',
        parts: parts,
      });
    }

    return googleMessages;
  }

  // Find the content block with the tool_use_id and return the name
  private getToolName(
    tool_use_id: string,
    messages: Message[],
  ): string | undefined {
    const toolMessage = messages.find((message) =>
      (message.content as MessageContentBlock[]).some(
        (block) =>
          block.type === MessageContentType.ToolUse && block.id === tool_use_id,
      ),
    );
    if (!toolMessage) {
      return undefined;
    }

    const toolBlock = (toolMessage.content as MessageContentBlock[]).find(
      (block) =>
        block.type === MessageContentType.ToolUse && block.id === tool_use_id,
    );
    if (!toolBlock) {
      return undefined;
    }
    return (toolBlock as ToolUseContentBlock).name;
  }

  /**
   * Convert Google Gemini's response content to our MessageContentBlock format
   */
  private formatGoogleResponse(parts: Part[]): MessageContentBlock[] {
    return parts.map((part) => {
      if (part.text) {
        return {
          type: MessageContentType.Text,
          text: part.text,
        } as TextContentBlock;
      }

      if (part.functionCall) {
        return {
          type: MessageContentType.ToolUse,
          id: part.functionCall.id || uuid(),
          name: part.functionCall.name,
          input: part.functionCall.args,
        } as ToolUseContentBlock;
      }

      this.logger.warn(`Unknown content type from Google: ${part}`);
      return {
        type: MessageContentType.Text,
        text: JSON.stringify(part),
      } as TextContentBlock;
    });
  }
}
