/**
 * LLM Provider Service
 * Phase 10 (v5.5.0): Enterprise Features - Custom LLM Provider Support
 *
 * Provides multi-provider LLM capabilities:
 * - Support for Anthropic, OpenAI, Azure OpenAI, Google Vertex AI, AWS Bedrock
 * - Per-tenant provider configuration
 * - Automatic fallback between providers
 * - Usage tracking and cost estimation
 * - Rate limiting per provider
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum LLMProvider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  AZURE_OPENAI = 'azure_openai',
  GOOGLE_VERTEX = 'google_vertex',
  AWS_BEDROCK = 'aws_bedrock',
}

export interface LLMRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface LLMResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  model: string;
  provider: LLMProvider;
  latencyMs: number;
  cached?: boolean;
}

export interface ProviderConfig {
  provider: LLMProvider;
  name: string;
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  region?: string;
  config?: Record<string, any>;
  isDefault?: boolean;
  isFallback?: boolean;
  priority?: number;
  maxRequestsPerMinute?: number;
  maxTokensPerRequest?: number;
}

// Provider-specific model defaults
const PROVIDER_DEFAULTS: Record<LLMProvider, { model: string; endpoint: string }> = {
  [LLMProvider.ANTHROPIC]: {
    model: 'claude-3-5-sonnet-20241022',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  [LLMProvider.OPENAI]: {
    model: 'gpt-4-turbo-preview',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
  [LLMProvider.AZURE_OPENAI]: {
    model: 'gpt-4',
    endpoint: '', // Requires custom endpoint
  },
  [LLMProvider.GOOGLE_VERTEX]: {
    model: 'gemini-1.5-pro',
    endpoint: 'https://us-central1-aiplatform.googleapis.com/v1',
  },
  [LLMProvider.AWS_BEDROCK]: {
    model: 'anthropic.claude-3-sonnet-20240229-v1:0',
    endpoint: '', // Uses AWS SDK
  },
};

// Approximate cost per 1M tokens (input/output)
const PROVIDER_COSTS: Record<LLMProvider, { input: number; output: number }> = {
  [LLMProvider.ANTHROPIC]: { input: 3.0, output: 15.0 },
  [LLMProvider.OPENAI]: { input: 10.0, output: 30.0 },
  [LLMProvider.AZURE_OPENAI]: { input: 10.0, output: 30.0 },
  [LLMProvider.GOOGLE_VERTEX]: { input: 1.25, output: 5.0 },
  [LLMProvider.AWS_BEDROCK]: { input: 3.0, output: 15.0 },
};

@Injectable()
export class LLMProviderService {
  private readonly logger = new Logger(LLMProviderService.name);
  private readonly defaultProvider: LLMProvider;
  private readonly defaultApiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.defaultProvider = LLMProvider.ANTHROPIC;
    this.defaultApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.logger.log('LLMProviderService initialized');
  }

  // ==========================================================================
  // Provider Configuration
  // ==========================================================================

  /**
   * Add or update an LLM provider configuration for a tenant
   */
  async configureProvider(tenantId: string, input: ProviderConfig): Promise<any> {
    // Validate provider
    if (!Object.values(LLMProvider).includes(input.provider)) {
      throw new BadRequestException(`Invalid provider: ${input.provider}`);
    }

    // If setting as default, unset other defaults
    if (input.isDefault) {
      await this.prisma.lLMProviderConfig.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const config = await this.prisma.lLMProviderConfig.upsert({
      where: {
        tenantId_provider_name: {
          tenantId,
          provider: input.provider,
          name: input.name,
        },
      },
      create: {
        tenantId,
        provider: input.provider,
        name: input.name,
        apiKey: input.apiKey,
        apiEndpoint: input.apiEndpoint || PROVIDER_DEFAULTS[input.provider].endpoint,
        model: input.model || PROVIDER_DEFAULTS[input.provider].model,
        region: input.region,
        config: input.config || {},
        isDefault: input.isDefault ?? false,
        isFallback: input.isFallback ?? false,
        priority: input.priority ?? 0,
        maxRequestsPerMinute: input.maxRequestsPerMinute,
        maxTokensPerRequest: input.maxTokensPerRequest,
        isEnabled: true,
      },
      update: {
        apiKey: input.apiKey,
        apiEndpoint: input.apiEndpoint,
        model: input.model,
        region: input.region,
        config: input.config,
        isDefault: input.isDefault,
        isFallback: input.isFallback,
        priority: input.priority,
        maxRequestsPerMinute: input.maxRequestsPerMinute,
        maxTokensPerRequest: input.maxTokensPerRequest,
      },
    });

    this.logger.log(`Configured LLM provider ${input.provider} for tenant ${tenantId}`);
    return this.maskSensitiveData(config);
  }

  /**
   * Get all provider configurations for a tenant
   */
  async getProviders(tenantId: string): Promise<any[]> {
    const configs = await this.prisma.lLMProviderConfig.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
    });

    return configs.map(c => this.maskSensitiveData(c));
  }

  /**
   * Get the default provider for a tenant
   */
  async getDefaultProvider(tenantId: string): Promise<any> {
    const config = await this.prisma.lLMProviderConfig.findFirst({
      where: { tenantId, isDefault: true, isEnabled: true },
    });

    return config ? this.maskSensitiveData(config) : null;
  }

  /**
   * Delete a provider configuration
   */
  async deleteProvider(tenantId: string, providerId: string): Promise<void> {
    const existing = await this.prisma.lLMProviderConfig.findFirst({
      where: { id: providerId, tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Provider configuration ${providerId} not found`);
    }

    await this.prisma.lLMProviderConfig.delete({
      where: { id: providerId },
    });

    this.logger.log(`Deleted LLM provider ${providerId} for tenant ${tenantId}`);
  }

  /**
   * Enable/disable a provider
   */
  async setProviderEnabled(tenantId: string, providerId: string, enabled: boolean): Promise<any> {
    const config = await this.prisma.lLMProviderConfig.updateMany({
      where: { id: providerId, tenantId },
      data: { isEnabled: enabled },
    });

    if (config.count === 0) {
      throw new NotFoundException(`Provider configuration ${providerId} not found`);
    }

    return { success: true, enabled };
  }

  // ==========================================================================
  // LLM Invocation
  // ==========================================================================

  /**
   * Call LLM with automatic provider selection and fallback
   */
  async call(tenantId: string, request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();

    // Get provider chain (default + fallbacks)
    const providers = await this.getProviderChain(tenantId);

    if (providers.length === 0) {
      // Use system default
      return this.callProvider(this.defaultProvider, {
        apiKey: this.defaultApiKey,
        model: PROVIDER_DEFAULTS[this.defaultProvider].model,
        endpoint: PROVIDER_DEFAULTS[this.defaultProvider].endpoint,
      }, request, startTime);
    }

    // Try each provider in order
    let lastError: Error | null = null;

    for (const provider of providers) {
      try {
        const response = await this.callProvider(
          provider.provider as LLMProvider,
          {
            apiKey: provider.apiKey!,
            model: provider.model || PROVIDER_DEFAULTS[provider.provider as LLMProvider].model,
            endpoint: provider.apiEndpoint || PROVIDER_DEFAULTS[provider.provider as LLMProvider].endpoint,
            config: provider.config as Record<string, any>,
          },
          request,
          startTime,
        );

        // Update usage stats
        await this.updateUsageStats(provider.id, response.tokensUsed.total);

        return response;
      } catch (error: any) {
        this.logger.warn(`Provider ${provider.provider} failed: ${error.message}`);
        lastError = error;

        // Emit event for monitoring
        this.eventEmitter.emit('llm.provider.failed', {
          tenantId,
          provider: provider.provider,
          error: error.message,
        });

        // Continue to next provider
      }
    }

    // All providers failed
    throw lastError || new Error('All LLM providers failed');
  }

  /**
   * Call a specific provider
   */
  private async callProvider(
    provider: LLMProvider,
    config: { apiKey: string; model: string; endpoint: string; config?: Record<string, any> },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    switch (provider) {
      case LLMProvider.ANTHROPIC:
        return this.callAnthropic(config, request, startTime);
      case LLMProvider.OPENAI:
        return this.callOpenAI(config, request, startTime);
      case LLMProvider.AZURE_OPENAI:
        return this.callAzureOpenAI(config, request, startTime);
      case LLMProvider.GOOGLE_VERTEX:
        return this.callGoogleVertex(config, request, startTime);
      case LLMProvider.AWS_BEDROCK:
        return this.callAWSBedrock(config, request, startTime);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  /**
   * Call Anthropic API
   */
  private async callAnthropic(
    config: { apiKey: string; model: string; endpoint: string },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.prompt }],
        stop_sequences: request.stopSequences,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.content[0]?.text || '',
      tokensUsed: {
        input: data.usage?.input_tokens || 0,
        output: data.usage?.output_tokens || 0,
        total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
      model: config.model,
      provider: LLMProvider.ANTHROPIC,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Call OpenAI API
   */
  private async callOpenAI(
    config: { apiKey: string; model: string; endpoint: string },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    const messages: any[] = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
        stop: request.stopSequences,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      tokensUsed: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
      model: config.model,
      provider: LLMProvider.OPENAI,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Call Azure OpenAI API
   */
  private async callAzureOpenAI(
    config: { apiKey: string; model: string; endpoint: string; config?: Record<string, any> },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    const deploymentName = config.config?.deploymentName || config.model;
    const apiVersion = config.config?.apiVersion || '2024-02-01';

    const url = `${config.endpoint}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;

    const messages: any[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.apiKey,
      },
      body: JSON.stringify({
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature ?? 0.7,
        stop: request.stopSequences,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Azure OpenAI API error: ${error}`);
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      tokensUsed: {
        input: data.usage?.prompt_tokens || 0,
        output: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
      model: deploymentName,
      provider: LLMProvider.AZURE_OPENAI,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Call Google Vertex AI (stub - requires Google Cloud SDK)
   */
  private async callGoogleVertex(
    config: { apiKey: string; model: string; endpoint: string; config?: Record<string, any> },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    // Note: Full implementation would use @google-cloud/aiplatform SDK
    throw new Error('Google Vertex AI requires Google Cloud SDK integration');
  }

  /**
   * Call AWS Bedrock (stub - requires AWS SDK)
   */
  private async callAWSBedrock(
    config: { apiKey: string; model: string; endpoint: string; config?: Record<string, any> },
    request: LLMRequest,
    startTime: number,
  ): Promise<LLMResponse> {
    // Note: Full implementation would use @aws-sdk/client-bedrock-runtime
    throw new Error('AWS Bedrock requires AWS SDK integration');
  }

  // ==========================================================================
  // Usage and Cost Tracking
  // ==========================================================================

  /**
   * Get usage statistics for a tenant
   */
  async getUsageStats(
    tenantId: string,
    options: { startDate?: Date; endDate?: Date } = {},
  ): Promise<{
    byProvider: Record<string, { tokens: number; requests: number; estimatedCost: number }>;
    total: { tokens: number; requests: number; estimatedCost: number };
  }> {
    const providers = await this.prisma.lLMProviderConfig.findMany({
      where: { tenantId },
    });

    const byProvider: Record<string, { tokens: number; requests: number; estimatedCost: number }> = {};
    let totalTokens = 0;
    let totalRequests = 0;
    let totalCost = 0;

    for (const provider of providers) {
      const tokens = Number(provider.totalTokensUsed);
      const requests = provider.totalRequestsCount;
      const costs = PROVIDER_COSTS[provider.provider as LLMProvider] || { input: 0, output: 0 };
      const estimatedCost = (tokens / 1000000) * ((costs.input + costs.output) / 2);

      byProvider[provider.provider] = {
        tokens,
        requests,
        estimatedCost: Math.round(estimatedCost * 100) / 100,
      };

      totalTokens += tokens;
      totalRequests += requests;
      totalCost += estimatedCost;
    }

    return {
      byProvider,
      total: {
        tokens: totalTokens,
        requests: totalRequests,
        estimatedCost: Math.round(totalCost * 100) / 100,
      },
    };
  }

  /**
   * Estimate cost for a request
   */
  estimateCost(provider: LLMProvider, inputTokens: number, outputTokens: number): number {
    const costs = PROVIDER_COSTS[provider];
    const inputCost = (inputTokens / 1000000) * costs.input;
    const outputCost = (outputTokens / 1000000) * costs.output;
    return Math.round((inputCost + outputCost) * 10000) / 10000;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Get provider chain for fallback
   */
  private async getProviderChain(tenantId: string): Promise<any[]> {
    return this.prisma.lLMProviderConfig.findMany({
      where: {
        tenantId,
        isEnabled: true,
        OR: [{ isDefault: true }, { isFallback: true }],
      },
      orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }],
    });
  }

  /**
   * Update usage statistics
   */
  private async updateUsageStats(providerId: string, tokensUsed: number): Promise<void> {
    await this.prisma.lLMProviderConfig.update({
      where: { id: providerId },
      data: {
        totalTokensUsed: { increment: BigInt(tokensUsed) },
        totalRequestsCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Mask sensitive data in config
   */
  private maskSensitiveData(config: any): any {
    return {
      ...config,
      apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : null,
    };
  }

  /**
   * Get available providers
   */
  getAvailableProviders(): Array<{
    provider: LLMProvider;
    name: string;
    defaultModel: string;
    costPer1MTokens: { input: number; output: number };
  }> {
    return Object.entries(PROVIDER_DEFAULTS).map(([provider, defaults]) => ({
      provider: provider as LLMProvider,
      name: this.getProviderDisplayName(provider as LLMProvider),
      defaultModel: defaults.model,
      costPer1MTokens: PROVIDER_COSTS[provider as LLMProvider],
    }));
  }

  /**
   * Get display name for provider
   */
  private getProviderDisplayName(provider: LLMProvider): string {
    const names: Record<LLMProvider, string> = {
      [LLMProvider.ANTHROPIC]: 'Anthropic (Claude)',
      [LLMProvider.OPENAI]: 'OpenAI (GPT)',
      [LLMProvider.AZURE_OPENAI]: 'Azure OpenAI',
      [LLMProvider.GOOGLE_VERTEX]: 'Google Vertex AI (Gemini)',
      [LLMProvider.AWS_BEDROCK]: 'AWS Bedrock',
    };
    return names[provider] || provider;
  }

  /**
   * Test a provider configuration
   */
  async testProvider(tenantId: string, providerId: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const config = await this.prisma.lLMProviderConfig.findFirst({
      where: { id: providerId, tenantId },
    });

    if (!config) {
      throw new NotFoundException(`Provider ${providerId} not found`);
    }

    try {
      const startTime = Date.now();
      const response = await this.callProvider(
        config.provider as LLMProvider,
        {
          apiKey: config.apiKey!,
          model: config.model || PROVIDER_DEFAULTS[config.provider as LLMProvider].model,
          endpoint: config.apiEndpoint || PROVIDER_DEFAULTS[config.provider as LLMProvider].endpoint,
          config: config.config as Record<string, any>,
        },
        { prompt: 'Hello, respond with "OK" only.' },
        startTime,
      );

      return {
        success: true,
        latencyMs: response.latencyMs,
      };
    } catch (error: any) {
      return {
        success: false,
        latencyMs: 0,
        error: error.message,
      };
    }
  }
}
