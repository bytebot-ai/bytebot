import { Injectable } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  ValidationError,
  UnauthorizedError,
  NetworkError,
  RateLimitError,
  NotFoundError
} from '../shared/errors';

const execAsync = promisify(exec);

@Injectable()
export class ApiKeysService {
  private readonly supportedProviders = [
    'ANTHROPIC',
    'OPENAI', 
    'GEMINI',
    'OPENROUTER',
    'MISTRAL',
    'COHERE',
    'GROQ',
    'PERPLEXITY',
    'TOGETHER',
    'DEEPSEEK',
    'FIREWORKS'
  ];

  async saveApiKeys(apiKeys: Record<string, string>): Promise<void> {
    // Validate provider names
    for (const [provider, apiKey] of Object.entries(apiKeys)) {
      const normalizedProvider = provider.toUpperCase().replace(/[^A-Z]/g, '');
      if (!this.supportedProviders.includes(normalizedProvider)) {
        throw new ValidationError(`Unsupported provider: ${provider}`);
      }
      
      // Basic validation for API key format
      if (apiKey && typeof apiKey === 'string') {
        // Set environment variables for the process and potentially the system
        const envVarName = `${normalizedProvider}_API_KEY`;
        process.env[envVarName] = apiKey;
      }
    }
  }

  async getApiKeyStatus(): Promise<Record<string, boolean>> {
    const status: Record<string, boolean> = {};
    
    // Check which API keys are configured (without exposing their values)
    const providerMap = {
      'anthropicApiKey': 'ANTHROPIC_API_KEY',
      'openaiApiKey': 'OPENAI_API_KEY',
      'geminiApiKey': 'GEMINI_API_KEY',
      'openrouterApiKey': 'OPENROUTER_API_KEY',
      'mistralApiKey': 'MISTRAL_API_KEY',
      'cohereApiKey': 'COHERE_API_KEY',
      'groqApiKey': 'GROQ_API_KEY',
      'perplexityApiKey': 'PERPLEXITY_API_KEY',
      'togetherApiKey': 'TOGETHER_API_KEY',
      'deepseekApiKey': 'DEEPSEEK_API_KEY',
      'fireworksApiKey': 'FIREWORKS_API_KEY'
    };

    for (const [frontendKey, envVar] of Object.entries(providerMap)) {
      // Check if environment variable exists and is not empty
      status[frontendKey] = !!(process.env[envVar] && process.env[envVar].trim().length > 0);
    }

    return status;
  }

  async testApiKey(provider: string, apiKey: string): Promise<any> {
    const normalizedProvider = provider.toUpperCase().replace(/[^A-Z]/g, '');
    
    if (!this.supportedProviders.includes(normalizedProvider)) {
      throw new ValidationError(`Unsupported provider: ${provider}`);
    }

    // Get the proxy URL from environment
    const proxyUrl = process.env.BYTEBOT_LLM_PROXY_URL;
    if (!proxyUrl) {
      throw new NetworkError('LiteLLM proxy URL not configured');
    }

    // Temporarily set the API key for testing
    const envVarName = `${normalizedProvider}_API_KEY`;
    const originalValue = process.env[envVarName];
    process.env[envVarName] = apiKey;

    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      // Use a simple model mapping for testing
      const testModel = this.getTestModelForProvider(normalizedProvider);

      const response = await fetch(`${proxyUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: testModel,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 5,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 401) {
        throw new UnauthorizedError('Invalid API key or authentication failed');
      }

      if (response.status === 429) {
        throw new RateLimitError('Rate limit exceeded for this API key');
      }

      if (!response.ok) {
        throw new NetworkError(`API test failed with status ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof UnauthorizedError || 
          error instanceof RateLimitError || error instanceof NetworkError) {
        throw error; // Re-throw our custom errors
      }
      
      if (error.name === 'AbortError') {
        throw new NetworkError('Request timeout - API key test took too long');
      }
      
      // For other network/fetch errors
      throw new NetworkError(`Failed to test API key: ${error.message}`);
    } finally {
      // Restore original value
      if (originalValue !== undefined) {
        process.env[envVarName] = originalValue;
      } else {
        delete process.env[envVarName];
      }
    }
  }

  private getTestModelForProvider(provider: string): string {
    // Simple model mapping for testing purposes
    const modelMap: Record<string, string> = {
      'ANTHROPIC': 'claude-3-5-sonnet-20241022',
      'OPENAI': 'gpt-4',
      'GEMINI': 'gemini-2.5-pro',
      'OPENROUTER': 'openrouter-auto',
      'MISTRAL': 'mistral-large',
      'COHERE': 'command-r-plus',
      'GROQ': 'groq-llama-3.1-70b',
      'PERPLEXITY': 'pplx-sonar-medium',
      'TOGETHER': 'together-llama-3-70b',
      'DEEPSEEK': 'deepseek-chat',
      'FIREWORKS': 'fireworks-llama-v3p1-405b'
    };
    
    return modelMap[provider] || 'gpt-4'; // Default fallback
  }
}