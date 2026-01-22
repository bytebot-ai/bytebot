/**
 * Proxy Service
 * v2.5.0: Added LLM resilience with retry logic and circuit breaker
 *
 * This service proxies LLM requests through LiteLLM and now includes:
 * - Exponential backoff with jitter for transient failures
 * - Circuit breaker to prevent cascading failures
 * - Error classification (retryable vs. permanent)
 * - Retry-after header support for rate limits
 *
 * @see LLMResilienceService for retry implementation details
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import OpenAI, { APIUserAbortError } from 'openai';
import { LLMResilienceService } from '../llm-resilience/llm-resilience.service';
import { LLMErrorType } from '../llm-resilience/llm-resilience.service';
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
} from '@bytebot/shared';
import { Message, Role } from '@prisma/client';
import { proxyTools } from './proxy.tools';
import {
  BytebotAgentService,
  BytebotAgentGenerateMessageOptions,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';
import { filterToolsByPolicy } from '../agent/tool-policy';

@Injectable()
export class ProxyService implements BytebotAgentService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly proxyApiKey: string;
  private readonly defaultProxyEndpoints: string[];
  private readonly desktopVisionProxyEndpoints: string[];
  private readonly defaultMaxImageBlocks: number;
  private readonly desktopVisionMaxImageBlocks: number;
  private readonly endpointPreflightEnabled: boolean;
  private readonly endpointPreflightTimeoutMs: number;
  private readonly endpointPreflightTtlMs: number;
  private readonly endpointPreflightCache = new Map<
    string,
    { ok: boolean; checkedAt: number }
  >();
  private readonly openaiClientsByBaseUrl = new Map<string, OpenAI>();

  constructor(
    private readonly configService: ConfigService,
    private readonly llmResilienceService: LLMResilienceService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const primaryProxyUrl = (this.configService.get<string>('BYTEBOT_LLM_PROXY_URL') || '').trim();
    this.proxyApiKey = (this.configService.get<string>('BYTEBOT_LLM_PROXY_API_KEY') || '').trim();

    const endpointsRaw = (this.configService.get<string>('BYTEBOT_LLM_PROXY_ENDPOINTS') || '').trim();
    const desktopVisionEndpointsRaw = (this.configService.get<string>('BYTEBOT_LLM_PROXY_DESKTOP_VISION_ENDPOINTS') || '').trim();

    this.defaultProxyEndpoints = this.parseProxyEndpoints(endpointsRaw) ||
      (primaryProxyUrl ? [this.normalizeBaseUrl(primaryProxyUrl)] : []);
    this.desktopVisionProxyEndpoints = this.parseProxyEndpoints(desktopVisionEndpointsRaw) ||
      this.defaultProxyEndpoints;

    this.defaultMaxImageBlocks = Math.max(
      0,
      parseInt(
        (this.configService.get<string>('BYTEBOT_LLM_MAX_IMAGE_BLOCKS') || '8').trim(),
        10,
      ) || 0,
    );
    this.desktopVisionMaxImageBlocks = Math.max(
      0,
      parseInt(
        (this.configService.get<string>('BYTEBOT_LLM_MAX_IMAGE_BLOCKS_DESKTOP_VISION') || '2').trim(),
        10,
      ) || 0,
    );

    this.endpointPreflightEnabled = this.parseBooleanEnv(
      this.configService.get<string>('BYTEBOT_LLM_PROXY_ENDPOINT_PREFLIGHT_ENABLED'),
      true,
    );
    this.endpointPreflightTimeoutMs = Math.max(
      100,
      parseInt(
        (
          this.configService.get<string>(
            'BYTEBOT_LLM_PROXY_ENDPOINT_PREFLIGHT_TIMEOUT_MS',
          ) || '2000'
        ).trim(),
        10,
      ) || 0,
    );
    this.endpointPreflightTtlMs = Math.max(
      0,
      parseInt(
        (
          this.configService.get<string>(
            'BYTEBOT_LLM_PROXY_ENDPOINT_PREFLIGHT_TTL_MS',
          ) || '5000'
        ).trim(),
        10,
      ) || 0,
    );

    if (this.defaultProxyEndpoints.length === 0) {
      this.logger.warn(
        'BYTEBOT_LLM_PROXY_URL is not set. ProxyService will not work properly.',
      );
    }

    const primaryForLog = this.defaultProxyEndpoints[0] ?? primaryProxyUrl ?? '';
    this.logger.log(
      `ProxyService initialized with LLM resilience (primary proxy: ${primaryForLog || 'unset'})`,
    );
  }

  private parseProxyEndpoints(raw: string): string[] | null {
    if (!raw) return null;
    const endpoints = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => this.normalizeBaseUrl(s));
    const unique = Array.from(new Set(endpoints));
    return unique.length > 0 ? unique : null;
  }

  private parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
    if (value == null) return defaultValue;
    const normalized = value.trim().toLowerCase();
    if (normalized === '') return defaultValue;
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return defaultValue;
  }

  private normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  protected async preflightEndpoint(
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.endpointPreflightEnabled) return true;

    const normalized = this.normalizeBaseUrl(baseUrl);
    const key = this.endpointKey(normalized);
    const now = Date.now();

    const cached = this.endpointPreflightCache.get(key);
    if (cached && now - cached.checkedAt < this.endpointPreflightTtlMs) {
      return cached.ok;
    }

    // Some callers set baseUrl to ".../v1". Health endpoints live on the root.
    const healthBase = normalized.replace(/\/v1$/, '');
    const url = `${healthBase}/health/readiness`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.endpointPreflightTimeoutMs);

    const abortFromUpstream = () => controller.abort();
    signal?.addEventListener('abort', abortFromUpstream, { once: true });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.proxyApiKey
          ? { Authorization: `Bearer ${this.proxyApiKey}` }
          : undefined,
        signal: controller.signal,
      });
      const ok = response.ok;
      this.endpointPreflightCache.set(key, { ok, checkedAt: now });
      return ok;
    } catch {
      this.endpointPreflightCache.set(key, { ok: false, checkedAt: now });
      return false;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abortFromUpstream);
    }
  }

  private sanitizeChatMessages(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const sanitized: ChatCompletionMessageParam[] = [];
    const seenToolCallIds = new Set<string>();

    for (const message of messages) {
      if (message.role === 'assistant') {
        const maybeToolCalls = (message as any).tool_calls as unknown;
        const toolCalls = Array.isArray(maybeToolCalls) ? maybeToolCalls : [];

        for (const toolCall of toolCalls) {
          if (toolCall && typeof toolCall.id === 'string' && toolCall.id.trim() !== '') {
            seenToolCallIds.add(toolCall.id);
          }
        }

        const content = (message as any).content as unknown;
        const hasContent =
          typeof content === 'string'
            ? content.trim().length > 0
            : Array.isArray(content)
              ? content.length > 0
              : content != null;
        const hasToolCalls = toolCalls.length > 0;

        if (!hasContent && !hasToolCalls) continue;
        sanitized.push(message);
        continue;
      }

      if (message.role === 'tool') {
        const toolCallId = (message as any).tool_call_id as unknown;
        if (
          typeof toolCallId === 'string' &&
          toolCallId.trim() !== '' &&
          !seenToolCallIds.has(toolCallId)
        ) {
          continue;
        }
        sanitized.push(message);
        continue;
      }

      sanitized.push(message);
    }

    return sanitized;
  }

  private coalesceAssistantMessages(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const coalesced: ChatCompletionMessageParam[] = [];

    for (const message of messages) {
      const previous = coalesced[coalesced.length - 1];
      if (message.role !== 'assistant' || previous?.role !== 'assistant') {
        coalesced.push(message);
        continue;
      }

      const prev = previous as any;
      const next = message as any;

      const prevToolCalls = Array.isArray(prev.tool_calls) ? prev.tool_calls : [];
      const nextToolCalls = Array.isArray(next.tool_calls) ? next.tool_calls : [];
      const toolCalls = [...prevToolCalls, ...nextToolCalls];

      const prevContent = prev.content;
      const nextContent = next.content;

      const mergedContent = this.mergeAssistantContent(prevContent, nextContent);

      coalesced[coalesced.length - 1] = {
        ...previous,
        ...message,
        ...(mergedContent != null && { content: mergedContent }),
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      };
    }

    return coalesced;
  }

  private mergeAssistantContent(
    left: unknown,
    right: unknown,
  ): string | null {
    const leftValue = this.normalizeAssistantContent(left);
    const rightValue = this.normalizeAssistantContent(right);

    if (leftValue == null) return rightValue;
    if (rightValue == null) return leftValue;

    const leftTrimmed = leftValue.trim();
    const rightTrimmed = rightValue.trim();
    if (!leftTrimmed) return rightValue;
    if (!rightTrimmed) return leftValue;
    return `${leftValue}\n\n${rightValue}`;
  }

  private normalizeAssistantContent(
    value: unknown,
  ): string | null {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const parts = value
        .map((part: any) => {
          if (!part || typeof part !== 'object') return null;
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
          if (typeof part.refusal === 'string') return part.refusal;
          return null;
        })
        .filter((text): text is string => typeof text === 'string');

      const combined = parts.join('\n').trim();
      return combined ? combined : null;
    }
    return null;
  }

  private isDesktopVisionRequestedModel(model: string): boolean {
    const trimmed = (model || '').trim();
    return (
      trimmed === 'desktop-vision' ||
      trimmed === 'claude-sonnet-4-5' ||
      trimmed === 'claude-opus-4-5' ||
      trimmed === 'qwen3-vl-32b' ||
      trimmed.endsWith('/qwen3-vl-32b') ||
      trimmed.endsWith('/claude-sonnet-4-5-20250929') ||
      trimmed.endsWith('/claude-opus-4-5-20251101')
    );
  }

  private getProxyEndpointsForModel(model: string): string[] {
    // Scoped stop-the-bleed: desktop-vision can use a different endpoint ordering (e.g., global-first).
    if (this.isDesktopVisionRequestedModel(model)) return this.desktopVisionProxyEndpoints;
    return this.defaultProxyEndpoints;
  }

  private endpointKey(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return `litellm:${url.host}`;
    } catch {
      return `litellm:${baseUrl}`;
    }
  }

  protected createOpenAIClient(baseURL: string): OpenAI {
    // Use proxy auth key when required (e.g., LiteLLM master_key enabled).
    // Keep dummy fallback for backwards compatibility with unauthenticated proxies.
    return new OpenAI({
      apiKey: this.proxyApiKey || 'dummy-key-for-proxy',
      baseURL,
      // v2.5.0: Increase default timeout to allow for retry logic
      timeout: 120000, // 2 minutes (increased from default 10 minutes)
    });
  }

  private getOpenAIClient(baseUrl: string): OpenAI {
    const normalized = this.normalizeBaseUrl(baseUrl);
    const existing = this.openaiClientsByBaseUrl.get(normalized);
    if (existing) return existing;
    const client = this.createOpenAIClient(normalized);
    this.openaiClientsByBaseUrl.set(normalized, client);
    return client;
  }

  /**
   * Check if a model is an OpenAI o-series reasoning model
   * These models support the reasoning_effort parameter
   */
  private isReasoningModel(model: string): boolean {
    // Extract model name from potential namespace (e.g., "openai/o3-..." -> "o3-...")
    const modelName = model.includes('/') ? model.split('/').pop() || model : model;
    // O-series models start with 'o' followed by a digit (o1, o3, etc.)
    return /^o\d/.test(modelName);
  }

  /**
   * Main method to generate messages using the Chat Completions API
   *
   * v2.5.0: Now includes retry logic with exponential backoff
   * - 5 retries for transient failures (timeout, rate limit, server errors)
   * - Circuit breaker to prevent cascading failures
   * - Abort signal still respected for user-initiated cancellation
   */
  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string,
    options: BytebotAgentGenerateMessageOptions = {},
  ): Promise<BytebotAgentResponse> {
    const useTools = options.useTools ?? true;
    const signal = options.signal;

    // Convert messages to Chat Completion format
    const chatMessages = this.coalesceAssistantMessages(
      this.sanitizeChatMessages(
        this.formatMessagesForChatCompletion(systemPrompt, messages, model),
      ),
    );

    // Determine if model supports reasoning_effort parameter
    // Only OpenAI o-series models (o1, o3, etc.) support this
    // Anthropic models use 'thinking' parameter instead (disabled via anthropic.service.ts)
    const isReasoning = this.isReasoningModel(model);

    // Prepare the Chat Completion request
    const tools = useTools
      ? filterToolsByPolicy(
          proxyTools,
          (tool) => tool.function.name,
          options.toolPolicy,
        )
      : [];

    const completionRequest: OpenAI.Chat.ChatCompletionCreateParams & {
      cache?: { 'no-cache': boolean };
    } = {
      model,
      messages: chatMessages,
      max_tokens: 8192,
      ...(tools.length > 0 && { tools }),
      // Only include reasoning_effort for o-series models
      // Non-reasoning models (Claude, GPT-4, etc.) don't support this parameter
      ...(isReasoning && { reasoning_effort: 'high' }),
    };

    // Desktop/Vision requests must be deterministic and must not be served from semantic cache.
    // This prevents a cached fallback (e.g., gpt-4o-mini) from masking a healthy qwen3-vl-32b backend.
    if (this.isDesktopVisionRequestedModel(model)) {
      completionRequest.cache = { 'no-cache': true };
    }

    const endpoints = this.getProxyEndpointsForModel(model);
    const attemptedEndpointKeys: string[] = [];
    let lastFailure: { errorType: string; errorMessage: string; attempts: number; durationMs: number } | null = null;

    for (let i = 0; i < endpoints.length; i++) {
      const baseUrl = endpoints[i];
      const key = this.endpointKey(baseUrl);
      attemptedEndpointKeys.push(key);

      const callStart = Date.now();
      const hasFallbackEndpoint = i < endpoints.length - 1;

      // Fast endpoint preflight to avoid OS-level TCP connect hangs (50s+ blackholes).
      // If the endpoint is not reachable/readiness-failing, fail over immediately.
      if (endpoints.length > 1) {
        const ok = await this.preflightEndpoint(baseUrl, signal);
        if (!ok) {
          const errorType = LLMErrorType.NETWORK;
          const errorMessage = `Endpoint preflight failed for ${key}`;

          lastFailure = {
            errorType,
            errorMessage,
            attempts: 0,
            durationMs: Date.now() - callStart,
          };

          this.llmResilienceService.openCircuit(key, {
            type: errorType,
            message: errorMessage,
            retryable: true,
            originalError: new Error(errorMessage),
          });

          if (hasFallbackEndpoint) {
            const nextKey = this.endpointKey(endpoints[i + 1]);
            this.eventEmitter.emit('llm.endpoint.failover', {
              fromEndpoint: key,
              toEndpoint: nextKey,
              reason: errorType,
              requestedModel: model,
            });
            this.logger.warn(
              `LLM endpoint preflight failed (${key}); failing over to ${nextKey}`,
            );
            continue;
          }

          break;
        }
      }

      const openai = this.getOpenAIClient(baseUrl);

      // v2.5.0+: Wrap API call with retry logic (maxRetries=0 per-endpoint; failover happens at the endpoint layer).
      const result = await this.llmResilienceService.executeWithRetry(
        async () => {
          // Check if aborted before making the call
          if (signal?.aborted) {
            throw new APIUserAbortError();
          }

          return await openai.chat.completions.create(completionRequest, { signal });
        },
        key,
        // Connection errors are INFRA: fail fast and fail over to next endpoint when configured.
        { maxRetries: 0 },
      );

      // Handle abort separately (not a retryable error)
      if (!result.success && result.error?.originalError instanceof APIUserAbortError) {
        this.logger.log('Chat Completion API call aborted by user');
        throw new BytebotAgentInterrupt();
      }

      if (result.success) {
        const completion = result.result!;
        this.eventEmitter.emit('llm.endpoint.call', {
          endpoint: key,
          requestedModel: model,
          durationMs: Date.now() - callStart,
        });

        // Emit failover event when LiteLLM routed to a different underlying model.
        // This is expected when model-group fallbacks are configured.
        if (completion.model && completion.model !== model) {
          this.eventEmitter.emit('llm.failover', {
            endpoint: key,
            requestedModel: model,
            usedModel: completion.model,
          });
        }

        // Process the response
        try {
          const choice = completion.choices?.[0];
          if (!choice || !choice.message) {
            throw new Error('No valid message in Chat Completion response');
          }

          // Convert response to MessageContentBlocks
          const contentBlocks = this.formatChatCompletionResponse(choice.message);
          if (contentBlocks.length === 0) {
            throw new Error('Chat Completion response contained no usable content blocks');
          }

          return {
            contentBlocks,
            tokenUsage: {
              inputTokens: completion.usage?.prompt_tokens || 0,
              outputTokens: completion.usage?.completion_tokens || 0,
              totalTokens: completion.usage?.total_tokens || 0,
            },
          };
        } catch (error: any) {
          const errorType = LLMErrorType.SERVER_ERROR;
          const errorMessage = error?.message || 'Invalid Chat Completion response';

          lastFailure = {
            errorType,
            errorMessage,
            attempts: result.attempts,
            durationMs: result.totalDurationMs,
          };

          const hasNextEndpoint = i < endpoints.length - 1;
          if (hasNextEndpoint) {
            // Treat invalid/empty responses as INFRA: open circuit and fail over to next endpoint.
            this.llmResilienceService.openCircuit(key, {
              type: errorType,
              message: errorMessage,
              retryable: true,
              originalError: error instanceof Error ? error : undefined,
            });

            const nextKey = this.endpointKey(endpoints[i + 1]);
            this.eventEmitter.emit('llm.endpoint.failover', {
              fromEndpoint: key,
              toEndpoint: nextKey,
              reason: errorType,
              requestedModel: model,
            });

            this.logger.warn(
              `LLM endpoint returned invalid response [${errorType}] (${key}); failing over to ${nextKey}`,
            );
            continue;
          }

          // No fallback endpoint available
          break;
        }
      }

      const errorType = result.error?.type || 'UNKNOWN';
      const errorMessage = result.error?.message || 'Unknown error';

      lastFailure = {
        errorType,
        errorMessage,
        attempts: result.attempts,
        durationMs: result.totalDurationMs,
      };

      // Endpoint-level failover decision: only for infrastructure failures.
      const isInfra =
        errorType === LLMErrorType.NETWORK ||
        errorType === LLMErrorType.TIMEOUT ||
        errorType === LLMErrorType.SERVER_ERROR ||
        errorType === LLMErrorType.OVERLOADED ||
        errorType === LLMErrorType.RATE_LIMIT;

      const hasNextEndpoint = i < endpoints.length - 1;
      if (isInfra && hasNextEndpoint) {
        // Open circuit immediately to prevent hammering a broken gateway.
        this.llmResilienceService.openCircuit(key, result.error || undefined);

        const nextKey = this.endpointKey(endpoints[i + 1]);
        this.eventEmitter.emit('llm.endpoint.failover', {
          fromEndpoint: key,
          toEndpoint: nextKey,
          reason: errorType,
          requestedModel: model,
        });

        this.logger.warn(
          `LLM endpoint failed [${errorType}] (${key}); failing over to ${nextKey}`,
        );
        continue;
      }

      // Non-infra failure (or no fallback endpoint): stop here.
      break;
    }

    const errorType = lastFailure?.errorType || 'UNKNOWN';
    const errorMessage = lastFailure?.errorMessage || 'Unknown error';
    const attempts = lastFailure?.attempts || 0;
    const durationMs = lastFailure?.durationMs || 0;

    this.logger.error(
      `LLM call failed after ${attempts} attempts: [${errorType}] ${errorMessage}`,
    );

    const error = new Error(`LLM API error after ${attempts} attempts: ${errorMessage}`);
    (error as any).llmErrorType = errorType;
    (error as any).attempts = attempts;
    (error as any).durationMs = durationMs;
    (error as any).attemptedEndpoints = attemptedEndpointKeys;
    throw error;
  }

  /**
   * Convert Bytebot messages to Chat Completion format
   */
  private formatMessagesForChatCompletion(
    systemPrompt: string,
    messages: Message[],
    requestedModel: string,
  ): ChatCompletionMessageParam[] {
    const chatMessages: ChatCompletionMessageParam[] = [];

    const maxImages = this.isDesktopVisionRequestedModel(requestedModel)
      ? this.desktopVisionMaxImageBlocks
      : this.defaultMaxImageBlocks;
    const includedImageRefs = this.getIncludedImageRefs(messages, maxImages);

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
            if (!includedImageRefs.has(block)) continue;
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
              if (!includedImageRefs.has(imageBlock)) break;
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
              // Do not replay thinking-only blocks back into the LLM context.
              // Some OpenAI-compatible servers reject assistant messages without `content` or `tool_calls`.
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
                  if (!includedImageRefs.has(content)) return;
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

  private getIncludedImageRefs(messages: Message[], maxImages: number): Set<unknown> {
    if (maxImages <= 0) return new Set();

    const imageRefs: unknown[] = [];
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      if (messageContentBlocks.every((block) => isUserActionContentBlock(block))) {
        const userActionBlocks = messageContentBlocks.flatMap((block) => block.content);
        for (const block of userActionBlocks) {
          if (isImageContentBlock(block)) {
            imageRefs.push(block);
          }
        }
        continue;
      }

      for (const block of messageContentBlocks) {
        if (block.type === MessageContentType.Image) {
          imageRefs.push(block);
          continue;
        }

        if (block.type === MessageContentType.ToolResult) {
          const toolResultBlock = block as ToolResultContentBlock;
          for (const content of toolResultBlock.content) {
            if (content.type === MessageContentType.Image) {
              imageRefs.push(content);
            }
          }
        }
      }
    }

    const include = new Set<unknown>();
    for (let i = imageRefs.length - 1; i >= 0 && include.size < maxImages; i--) {
      include.add(imageRefs[i]);
    }
    return include;
  }

  /**
   * Convert Chat Completion response to MessageContentBlocks
   */
  private formatChatCompletionResponse(
    message: OpenAI.Chat.ChatCompletionMessage,
  ): MessageContentBlock[] {
    const contentBlocks: MessageContentBlock[] = [];

    // Handle text content
    if (message.content) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: message.content,
      } as TextContentBlock);
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(toolCall.function.arguments || '{}');
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
