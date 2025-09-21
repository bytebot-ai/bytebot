import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIUserAbortError } from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  isUserActionContentBlock,
  isComputerToolUseContentBlock,
  isImageContentBlock,
  ThinkingContentBlock,
} from '@bytebot/shared';
import { Message, Role } from '@prisma/client';
import { doubaoTools } from './doubao.tools';
import {
  BytebotAgentService,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';
import { DEFAULT_DISPLAY_SIZE } from '../agent/agent.constants';
import { DEFAULT_MODEL } from './doubao.constants';

@Injectable()
export class DoubaoService implements BytebotAgentService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(DoubaoService.name);

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('DOUBAO_API_KEY');
    const baseURL = this.configService.get<string>('DOUBAO_BASE_URL');

    if (!apiKey) {
      this.logger.warn(
        'DOUBAO_API_KEY is not set. DoubaoService will not work properly.',
      );
    }

    // Initialize OpenAI client with proxy configuration
    this.openai = new OpenAI({
      apiKey: apiKey || 'dummy-key-for-initialization',
      baseURL: baseURL || 'https://ark.cn-beijing.volces.com/api/v3',
    });
  }

  /**
   * Main method to generate messages using the Chat Completions API
   */
  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string,
    useTools: boolean = true,
    signal?: AbortSignal,
  ): Promise<BytebotAgentResponse> {
    // Convert messages to Chat Completion format
    const chatMessages = this.formatMessagesForChatCompletion(
      systemPrompt,
      messages,
    );
    this.logger.debug('chatMessages' + JSON.stringify(chatMessages, null, 2));
    try {
      // Prepare the Chat Completion request
      const completionRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model,
        messages: chatMessages,
        max_tokens: 8192,
        ...(useTools && { tools: doubaoTools }),
        reasoning_effort: 'high',
      };

      // Make the API call
      const completion = await this.openai.chat.completions.create(
        completionRequest,
        { signal },
      );

      this.logger.debug('completion' + JSON.stringify(completion, null, 2));

      // Process the response
      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new Error('No valid response from Chat Completion API');
      }

      // Convert response to MessageContentBlocks
      const contentBlocks = this.formatChatCompletionResponse(
        choice.message,
        model,
      );

      this.logger.debug(
        'contentBlocks' + JSON.stringify(contentBlocks, null, 2),
      );

      return {
        contentBlocks,
        tokenUsage: {
          inputTokens: completion.usage?.prompt_tokens || 0,
          outputTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
      };
    } catch (error: any) {
      if (error instanceof APIUserAbortError) {
        this.logger.log('Chat Completion API call aborted');
        throw new BytebotAgentInterrupt();
      }

      this.logger.error(
        `Error sending message to proxy: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Convert Bytebot messages to Chat Completion format
   */
  private formatMessagesForChatCompletion(
    systemPrompt: string,
    messages: Message[],
  ): ChatCompletionMessageParam[] {
    const chatMessages: ChatCompletionMessageParam[] = [];

    // Add system message
    chatMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Process each message
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      // Handle user actions specially
      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );

        for (const block of userActionBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            chatMessages.push({
              role: 'user',
              content: `User performed action: ${block.name}\n${JSON.stringify(
                block.input,
                null,
                2,
              )}`,
            });
          } else if (isImageContentBlock(block)) {
            chatMessages.push({
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                    detail: 'high',
                  },
                },
              ],
            });
          }
        }
      } else {
        for (const block of messageContentBlocks) {
          switch (block.type) {
            case MessageContentType.Text: {
              chatMessages.push({
                role: message.role === Role.USER ? 'user' : 'assistant',
                content: block.text,
              });
              break;
            }
            case MessageContentType.Image: {
              const imageBlock = block as ImageContentBlock;
              chatMessages.push({
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                      detail: 'high',
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.ToolUse: {
              const toolBlock = block as ToolUseContentBlock;
              chatMessages.push({
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: toolBlock.id,
                    type: 'function',
                    function: {
                      name: toolBlock.name,
                      arguments: JSON.stringify(toolBlock.input),
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.Thinking: {
              const thinkingBlock = block as ThinkingContentBlock;
              const message: ChatCompletionMessageParam = {
                role: 'assistant',
                content: '',
              };
              message['reasoning_content'] = thinkingBlock.thinking;
              chatMessages.push(message);
              break;
            }
            case MessageContentType.ToolResult: {
              const toolResultBlock = block as ToolResultContentBlock;

              if (
                toolResultBlock.content.every(
                  (content) => content.type === MessageContentType.Image,
                )
              ) {
                chatMessages.push({
                  role: 'tool',
                  tool_call_id: toolResultBlock.tool_use_id,
                  content: 'screenshot',
                });
              }

              toolResultBlock.content.forEach((content) => {
                if (content.type === MessageContentType.Text) {
                  chatMessages.push({
                    role: 'tool',
                    tool_call_id: toolResultBlock.tool_use_id,
                    content: content.text,
                  });
                }

                if (content.type === MessageContentType.Image) {
                  chatMessages.push({
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'Screenshot',
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: `data:${content.source.media_type};base64,${content.source.data}`,
                          detail: 'high',
                        },
                      },
                    ],
                  });
                }
              });
              break;
            }
          }
        }
      }
    }

    return chatMessages;
  }

  /**
   * Convert Chat Completion response to MessageContentBlocks
   */
  private formatChatCompletionResponse(
    message: OpenAI.Chat.ChatCompletionMessage,
    model,
  ): MessageContentBlock[] {
    const contentBlocks: MessageContentBlock[] = [];

    // Handle text content
    if (message.content) {
      //Doubao sometimes places the JSON for tool_calls in the content field. It needs to be extracted and moved into the tool_calls field.
      const pattern =
        /<\[PLHD\d+_never_used_[a-f0-9]+\]>\[(.*?)\]<\[PLHD\d+_never_used_[a-f0-9]+\]>/;
      const pattern2 = /\[?(.*?)\]?<\|FunctionCallEnd\|>/;

      const match = message.content?.match(pattern) || null;
      const match2 = message.content?.match(pattern2) || null;
      if (match) {
        this.logger.debug(
          'Doubao places the JSON for tool_calls in the content field,content:' +
            JSON.stringify(message.content),
        );
        try {
          const toolData = JSON.parse(match[1]);
          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: toolData.name,
            input: toolData.parameters,
          } as ToolUseContentBlock);
        } catch (error) {
          this.logger.error(
            'extract from content and moved into the tool_calls field error:',
            error,
          );
        }
      } else if (match2) {
        this.logger.debug(
          'Doubao places the JSON for tool_calls in the content field,content:' +
            JSON.stringify(message.content),
        );
        try {
          const toolData = JSON.parse(match2[1]);
          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: toolData.name,
            input: toolData.parameters,
          } as ToolUseContentBlock);
        } catch (error) {
          this.logger.error(
            'extract from content and moved into the tool_calls field error:',
            error,
          );
        }
      } else {
        contentBlocks.push({
          type: MessageContentType.Text,
          text: message.content,
        } as TextContentBlock);
      }
    }

    if (message['reasoning_content']) {
      contentBlocks.push({
        type: MessageContentType.Thinking,
        thinking: message['reasoning_content'],
        signature: message['reasoning_content'],
      } as ThinkingContentBlock);
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(toolCall.function.arguments || '{}');
            if (
              'coordinates' in parsedInput &&
              parsedInput.coordinates !== undefined &&
              parsedInput.coordinates !== null
            ) {
              if (
                parsedInput.coordinates &&
                typeof parsedInput.coordinates === 'object' &&
                !Array.isArray(parsedInput.coordinates)
              ) {
                //Doubao returns coordinates based on a 1000*1000 screen, which need to be converted to the correct coordinates.
                if ('x' in parsedInput.coordinates) {
                  this.logger.debug(
                    'before doubao coordinates transfer x:' +
                      parsedInput.coordinates.x,
                  );
                  if (
                    typeof parsedInput?.coordinates?.x === 'number' &&
                    Number.isInteger(parsedInput.coordinates.x)
                  ) {
                    parsedInput.coordinates.x =
                      (parsedInput.coordinates.x / 1000) *
                      DEFAULT_DISPLAY_SIZE.width;
                  }
                  this.logger.debug(
                    'after doubao coordinates transfer x:' +
                      parsedInput.coordinates.x,
                  );
                }
                if ('y' in parsedInput.coordinates) {
                  this.logger.debug(
                    'before doubao coordinates transfer y:' +
                      parsedInput.coordinates.y,
                  );
                  if (
                    typeof parsedInput?.coordinates?.y === 'number' &&
                    Number.isInteger(parsedInput.coordinates.y)
                  ) {
                    parsedInput.coordinates.y =
                      (parsedInput.coordinates.y / 1000) *
                      DEFAULT_DISPLAY_SIZE.height;
                  }
                  this.logger.debug(
                    'after doubao coordinates transfer y:' +
                      parsedInput.coordinates.y,
                  );
                }
              }
            }
          } catch (e) {
            this.logger.warn(
              `Failed to parse tool call arguments: ${toolCall.function.arguments}`,
            );
            parsedInput = {};
          }

          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          } as ToolUseContentBlock);
        }
      }
    }

    // Handle refusal
    if (message.refusal) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: `Refusal: ${message.refusal}`,
      } as TextContentBlock);
    }

    return contentBlocks;
  }
}
