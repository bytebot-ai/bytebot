import { Message } from '@prisma/client';
import { BytebotAgentResponse } from '../agent/agent.types';

/**
 * Base interface for all AI provider services
 * This provides a common contract for all AI providers
 */
export interface BaseProvider {
  /**
   * Send a message to the AI provider and get a response
   */
  send(
    systemPrompt: string,
    messages: Message[],
    model: string,
    useTools: boolean,
    signal?: AbortSignal,
  ): Promise<BytebotAgentResponse>;

  /**
   * Stream a message to the AI provider (optional implementation)
   */
  stream?(
    systemPrompt: string,
    messages: Message[],
    model: string,
    useTools: boolean,
    signal?: AbortSignal,
  ): AsyncGenerator<Partial<BytebotAgentResponse>>;

  /**
   * Health check for the provider
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get available models for this provider
   */
  getAvailableModels(): Promise<string[]>;
}