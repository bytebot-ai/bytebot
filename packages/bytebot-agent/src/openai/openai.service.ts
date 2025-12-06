import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIUserAbortError } from 'openai';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ThinkingContentBlock,
  isUserActionContentBlock,
  isComputerToolUseContentBlock,
  isImageContentBlock,
} from '@bytebot/shared';
import { DEFAULT_MODEL, OPENAI_MODELS } from './openai.constants';
import { Message, Role } from '@prisma/client';
import { openaiTools } from './openai.tools';
import {
  BytebotAgentService,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
  BytebotAgentModel,
} from '../agent/agent.types';

@Injectable()
export class OpenAIService implements BytebotAgentService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(OpenAIService.name);
  private cachedModels: BytebotAgentModel[] | null = null;
  private modelsCacheTime: number = 0;
  private readonly CACHE_DURATION = 3600000; // 1 hour in milliseconds

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

  /**
   * Fetch available models from OpenAI API and cache them
   */
  async getAvailableModels(): Promise<BytebotAgentModel[]> {
    // Return cached models if still valid
    const now = Date.now();
    if (
      this.cachedModels &&
      now - this.modelsCacheTime < this.CACHE_DURATION
    ) {
      return this.cachedModels;
    }

    try {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) {
        this.logger.warn('OPENAI_API_KEY not set, returning hardcoded models');
        return OPENAI_MODELS;
      }

      // Fetch models from OpenAI API
      const modelsList = await this.openai.models.list();
      const models = modelsList.data;

      // Filter for relevant chat models that support vision (images/screenshots)
      // Exclude O1 and O3 models as they don't support image inputs
      const availableModels: BytebotAgentModel[] = models
        .filter(
          (model) =>
            model.id.startsWith('gpt-') &&
            !model.id.startsWith('gpt-3.5') && // Exclude GPT-3.5 (no vision support)
            !model.id.includes('instruct'), // Exclude instruct models
        )
        .map((model) => ({
          provider: 'openai' as const,
          name: model.id,
          title: this.formatModelTitle(model.id),
          contextWindow: this.getContextWindow(model.id),
        }))
        .sort((a, b) => {
          // Sort by priority: gpt-4o variants first, then gpt-4 variants
          const priority = (name: string) => {
            if (name.includes('gpt-4o')) return 0;
            if (name.includes('gpt-4.1')) return 1;
            if (name.includes('gpt-4')) return 2;
            if (name.includes('gpt-5')) return 3;
            return 4;
          };
          return priority(a.name) - priority(b.name);
        });

      if (availableModels.length > 0) {
        this.cachedModels = availableModels;
        this.modelsCacheTime = now;
        this.logger.log(
          `Fetched ${availableModels.length} models from OpenAI API`,
        );
        return availableModels;
      } else {
        this.logger.warn(
          'No suitable models found from OpenAI API, using hardcoded list',
        );
        return OPENAI_MODELS;
      }
    } catch (error) {
      this.logger.error(`Failed to fetch models from OpenAI: ${error.message}`);
      return OPENAI_MODELS;
    }
  }

  /**
   * Format model ID into a human-readable title
   */
  private formatModelTitle(modelId: string): string {
    // Convert model IDs like "gpt-4o-mini" to "GPT-4o Mini"
    return modelId
      .split('-')
      .map((part) => {
        if (part === 'gpt') return 'GPT';
        if (part.match(/^\d/)) return part; // Keep numbers as-is
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('-')
      .replace(/-/g, ' ');
  }

  /**
   * Get estimated context window for a model
   */
  private getContextWindow(modelId: string): number {
    if (modelId.includes('gpt-4o')) return 128000;
    if (modelId.includes('gpt-4-turbo')) return 128000;
    if (modelId.includes('gpt-4')) return 8192;
    if (modelId.includes('o1')) return 128000;
    if (modelId.includes('o3')) return 200000;
    if (modelId.includes('gpt-3.5')) return 16385;
    return 4096; // Default fallback
  }

  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string = DEFAULT_MODEL.name,
    useTools: boolean = true,
    signal?: AbortSignal,
  ): Promise<BytebotAgentResponse> {
    const isReasoning = model.startsWith('o');
    try {
      const openaiMessages = this.formatMessagesForOpenAI(messages);

      const maxTokens = 8192;
      const response = await this.openai.responses.create(
        {
          model,
          max_output_tokens: maxTokens,
          input: openaiMessages,
          instructions: systemPrompt,
          tools: useTools ? openaiTools : [],
          reasoning: isReasoning ? { effort: 'medium' } : null,
          store: false,
          include: isReasoning ? ['reasoning.encrypted_content'] : [],
        },
        { signal },
      );

      return {
        contentBlocks: this.formatOpenAIResponse(response.output),
        tokenUsage: {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
          totalTokens: response.usage?.total_tokens || 0,
        },
      };
    } catch (error: any) {
      console.log('error', error);
      console.log('error name', error.name);

      if (error instanceof APIUserAbortError) {
        this.logger.log('OpenAI API call aborted');
        throw new BytebotAgentInterrupt();
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
  ): OpenAI.Responses.ResponseInputItem[] {
    const openaiMessages: OpenAI.Responses.ResponseInputItem[] = [];

    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionContentBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );
        for (const block of userActionContentBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            openaiMessages.push({
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `User performed action: ${block.name}\n${JSON.stringify(block.input, null, 2)}`,
                },
              ],
            });
          } else if (isImageContentBlock(block)) {
            openaiMessages.push({
              role: 'user',
              type: 'message',
              content: [
                {
                  type: 'input_image',
                  detail: 'high',
                  image_url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
              ],
            } as OpenAI.Responses.ResponseInputItem.Message);
          }
        }
      } else {
        // Convert content blocks to OpenAI format
        for (const block of messageContentBlocks) {
          switch (block.type) {
            case MessageContentType.Text: {
              if (message.role === Role.USER) {
                openaiMessages.push({
                  type: 'message',
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text: block.text,
                    },
                  ],
                } as OpenAI.Responses.ResponseInputItem.Message);
              } else {
                openaiMessages.push({
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: block.text,
                    },
                  ],
                } as OpenAI.Responses.ResponseOutputMessage);
              }
              break;
            }
            case MessageContentType.ToolUse:
              // For assistant messages with tool use, convert to function call
              if (message.role === Role.ASSISTANT) {
                const toolBlock = block as ToolUseContentBlock;
                openaiMessages.push({
                  type: 'function_call',
                  call_id: toolBlock.id,
                  name: toolBlock.name,
                  arguments: JSON.stringify(toolBlock.input),
                } as OpenAI.Responses.ResponseFunctionToolCall);
              }
              break;

            case MessageContentType.Thinking: {
              const thinkingBlock = block;
              openaiMessages.push({
                type: 'reasoning',
                id: thinkingBlock.signature,
                encrypted_content: thinkingBlock.thinking,
                summary: [],
              } as OpenAI.Responses.ResponseReasoningItem);
              break;
            }
            case MessageContentType.ToolResult: {
              // Handle tool results as function call outputs
              const toolResult = block;
              // Tool results should be added as separate items in the response

              toolResult.content.forEach((content) => {
                if (content.type === MessageContentType.Text) {
                  openaiMessages.push({
                    type: 'function_call_output',
                    call_id: toolResult.tool_use_id,
                    output: content.text,
                  } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
                }

                if (content.type === MessageContentType.Image) {
                  openaiMessages.push({
                    type: 'function_call_output',
                    call_id: toolResult.tool_use_id,
                    output: 'screenshot',
                  } as OpenAI.Responses.ResponseInputItem.FunctionCallOutput);
                  openaiMessages.push({
                    role: 'user',
                    type: 'message',
                    content: [
                      {
                        type: 'input_image',
                        detail: 'high',
                        image_url: `data:${content.source.media_type};base64,${content.source.data}`,
                      },
                    ],
                  } as OpenAI.Responses.ResponseInputItem.Message);
                }
              });
              break;
            }

            default:
              // Handle unknown content types as text
              openaiMessages.push({
                role: 'user',
                type: 'message',
                content: [
                  {
                    type: 'input_text',
                    text: JSON.stringify(block),
                  },
                ],
              } as OpenAI.Responses.ResponseInputItem.Message);
          }
        }
      }
    }

    return openaiMessages;
  }

  private formatOpenAIResponse(
    response: OpenAI.Responses.ResponseOutputItem[],
  ): MessageContentBlock[] {
    const contentBlocks: MessageContentBlock[] = [];

    for (const item of response) {
      // Check the type of the output item
      switch (item.type) {
        case 'message':
          // Handle ResponseOutputMessage
          const message = item;
          for (const content of message.content) {
            if ('text' in content) {
              // ResponseOutputText
              contentBlocks.push({
                type: MessageContentType.Text,
                text: content.text,
              } as TextContentBlock);
            } else if ('refusal' in content) {
              // ResponseOutputRefusal
              contentBlocks.push({
                type: MessageContentType.Text,
                text: `Refusal: ${content.refusal}`,
              } as TextContentBlock);
            }
          }
          break;

        case 'function_call':
          // Handle ResponseFunctionToolCall
          const toolCall = item;
          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: toolCall.call_id,
            name: toolCall.name,
            input: JSON.parse(toolCall.arguments),
          } as ToolUseContentBlock);
          break;

        case 'file_search_call':
        case 'web_search_call':
        case 'computer_call':
        case 'reasoning':
          const reasoning = item as OpenAI.Responses.ResponseReasoningItem;
          if (reasoning.encrypted_content) {
            contentBlocks.push({
              type: MessageContentType.Thinking,
              thinking: reasoning.encrypted_content,
              signature: reasoning.id,
            } as ThinkingContentBlock);
          }
          break;
        case 'image_generation_call':
        case 'code_interpreter_call':
        case 'local_shell_call':
        case 'mcp_call':
        case 'mcp_list_tools':
        case 'mcp_approval_request':
          // Handle other tool types as text for now
          this.logger.warn(
            `Unsupported response output item type: ${item.type}`,
          );
          contentBlocks.push({
            type: MessageContentType.Text,
            text: JSON.stringify(item),
          } as TextContentBlock);
          break;

        default:
          // Handle unknown types
          this.logger.warn(
            `Unknown response output item type: ${JSON.stringify(item)}`,
          );
          contentBlocks.push({
            type: MessageContentType.Text,
            text: JSON.stringify(item),
          } as TextContentBlock);
      }
    }

    return contentBlocks;
  }
}
