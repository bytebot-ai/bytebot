import { Message } from '@prisma/client';
import { MessageContentBlock } from '@bytebot/shared';
import { ToolPolicyContext } from './tool-policy';

export interface BytebotAgentResponse {
  contentBlocks: MessageContentBlock[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface BytebotAgentService {
  generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string,
    options?: BytebotAgentGenerateMessageOptions,
  ): Promise<BytebotAgentResponse>;
}

export interface BytebotAgentGenerateMessageOptions {
  useTools?: boolean;
  toolPolicy?: ToolPolicyContext;
  signal?: AbortSignal;
}

export interface BytebotAgentModel {
  provider: 'anthropic' | 'openai' | 'google' | 'proxy';
  name: string;
  title: string;
  contextWindow?: number;
}

export class BytebotAgentInterrupt extends Error {
  constructor() {
    super('BytebotAgentInterrupt');
    this.name = 'BytebotAgentInterrupt';
  }
}
