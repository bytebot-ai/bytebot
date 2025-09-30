import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicService } from '../anthropic/anthropic.service';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import { OpenRouterService } from '../openrouter/openrouter.service';
import { ProxyService } from '../proxy/proxy.service';
import { BytebotAgentService, BytebotAgentModel } from '../agent/agent.types';
import { ANTHROPIC_MODELS } from '../anthropic/anthropic.constants';
import { OPENAI_MODELS } from '../openai/openai.constants';
import { GOOGLE_MODELS } from '../google/google.constants';
import { OPENROUTER_MODELS } from '../openrouter/openrouter.constants';

export interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  isEnabled: boolean;
  envVarName: string;
  models: BytebotAgentModel[];
}

@Injectable()
export class ProviderManagerService {
  private readonly logger = new Logger(ProviderManagerService.name);
  private readonly services: Record<string, BytebotAgentService> = {};
  private readonly providerConfigs: ProviderConfig[] = [
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      description: 'Advanced AI models from Anthropic with strong reasoning capabilities',
      isEnabled: false,
      envVarName: 'ANTHROPIC_API_KEY',
      models: ANTHROPIC_MODELS,
    },
    {
      id: 'openai',
      name: 'OpenAI',
      description: 'GPT models from OpenAI with broad capabilities',
      isEnabled: false,
      envVarName: 'OPENAI_API_KEY',
      models: OPENAI_MODELS,
    },
    {
      id: 'google',
      name: 'Google Gemini',
      description: 'Google\'s multimodal AI models with large context windows',
      isEnabled: false,
      envVarName: 'GEMINI_API_KEY',
      models: GOOGLE_MODELS,
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      description: 'Access to multiple AI models through a unified API',
      isEnabled: false,
      envVarName: 'OPENROUTER_API_KEY',
      models: OPENROUTER_MODELS,
    },
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly openrouterService: OpenRouterService,
    private readonly proxyService: ProxyService,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      openrouter: this.openrouterService,
      proxy: this.proxyService,
    };

    this.initializeProviderStatus();
  }

  /**
   * Initialize provider availability based on API key configuration
   */
  private initializeProviderStatus(): void {
    for (const provider of this.providerConfigs) {
      const apiKey = this.configService.get<string>(provider.envVarName);
      provider.isEnabled = !!(apiKey && apiKey.trim().length > 0);
      
      this.logger.log(
        `Provider ${provider.name}: ${provider.isEnabled ? 'enabled' : 'disabled'}`
      );
    }
  }

  /**
   * Get all available providers with their status
   */
  getAvailableProviders(): ProviderConfig[] {
    return this.providerConfigs.map(provider => ({ ...provider }));
  }

  /**
   * Get enabled providers only
   */
  getEnabledProviders(): ProviderConfig[] {
    return this.providerConfigs.filter(provider => provider.isEnabled);
  }

  /**
   * Get a specific provider service
   */
  getProviderService(providerId: string): BytebotAgentService | null {
    return this.services[providerId] || null;
  }

  /**
   * Get all available models from all enabled providers
   */
  getAllAvailableModels(): BytebotAgentModel[] {
    const models: BytebotAgentModel[] = [];
    
    for (const provider of this.providerConfigs) {
      if (provider.isEnabled) {
        models.push(...provider.models);
      }
    }

    return models;
  }

  /**
   * Get models for a specific provider
   */
  getModelsForProvider(providerId: string): BytebotAgentModel[] {
    const provider = this.providerConfigs.find(p => p.id === providerId);
    return provider?.models || [];
  }

  /**
   * Get default model (first available model from enabled providers)
   */
  getDefaultModel(): BytebotAgentModel | null {
    const availableModels = this.getAllAvailableModels();
    return availableModels.length > 0 ? availableModels[0] : null;
  }

  /**
   * Check if a provider is enabled
   */
  isProviderEnabled(providerId: string): boolean {
    const provider = this.providerConfigs.find(p => p.id === providerId);
    return provider?.isEnabled || false;
  }

  /**
   * Refresh provider status (useful after API key changes)
   */
  refreshProviderStatus(): void {
    this.initializeProviderStatus();
  }

  /**
   * Test a provider connection
   */
  async testProvider(providerId: string): Promise<boolean> {
    if (!this.isProviderEnabled(providerId)) {
      return false;
    }

    const service = this.getProviderService(providerId);
    if (!service) {
      return false;
    }

    try {
      // If the service implements BaseProvider interface and has healthCheck
      if ('healthCheck' in service && typeof service.healthCheck === 'function') {
        return await service.healthCheck();
      }
      
      // Fallback: try a simple API call
      // This is a basic implementation - could be enhanced
      return true;
    } catch (error) {
      this.logger.error(`Provider ${providerId} test failed:`, error);
      return false;
    }
  }
}