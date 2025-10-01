import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProviderManagerService } from '../provider-manager.service';
import { AnthropicService } from '../../anthropic/anthropic.service';
import { OpenAIService } from '../../openai/openai.service';
import { GoogleService } from '../../google/google.service';
import { OpenRouterService } from '../../openrouter/openrouter.service';
import { ProxyService } from '../../proxy/proxy.service';

describe('ProviderManagerService', () => {
  let service: ProviderManagerService;
  let configService: ConfigService;

  const mockAnthropicService = {};
  const mockOpenAIService = {};
  const mockGoogleService = {};
  const mockOpenRouterService = {
    healthCheck: jest.fn().mockResolvedValue(true),
  };
  const mockProxyService = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderManagerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const mockConfig = {
                'ANTHROPIC_API_KEY': 'test-anthropic-key',
                'OPENAI_API_KEY': '',
                'GEMINI_API_KEY': 'test-gemini-key',
                'OPENROUTER_API_KEY': 'test-openrouter-key',
              };
              return mockConfig[key];
            }),
          },
        },
        {
          provide: AnthropicService,
          useValue: mockAnthropicService,
        },
        {
          provide: OpenAIService,
          useValue: mockOpenAIService,
        },
        {
          provide: GoogleService,
          useValue: mockGoogleService,
        },
        {
          provide: OpenRouterService,
          useValue: mockOpenRouterService,
        },
        {
          provide: ProxyService,
          useValue: mockProxyService,
        },
      ],
    }).compile();

    service = module.get<ProviderManagerService>(ProviderManagerService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAvailableProviders', () => {
    it('should return all provider configurations', () => {
      const providers = service.getAvailableProviders();
      expect(providers).toHaveLength(4);
      expect(providers.map(p => p.id)).toEqual(['anthropic', 'openai', 'google', 'openrouter']);
    });

    it('should correctly set enabled status based on API keys', () => {
      const providers = service.getAvailableProviders();
      
      const anthropic = providers.find(p => p.id === 'anthropic');
      const openai = providers.find(p => p.id === 'openai');
      const google = providers.find(p => p.id === 'google');
      const openrouter = providers.find(p => p.id === 'openrouter');

      expect(anthropic?.isEnabled).toBe(true);
      expect(openai?.isEnabled).toBe(false);
      expect(google?.isEnabled).toBe(true);
      expect(openrouter?.isEnabled).toBe(true);
    });
  });

  describe('getEnabledProviders', () => {
    it('should return only enabled providers', () => {
      const enabledProviders = service.getEnabledProviders();
      expect(enabledProviders).toHaveLength(3);
      expect(enabledProviders.map(p => p.id)).toEqual(['anthropic', 'google', 'openrouter']);
    });
  });

  describe('getProviderService', () => {
    it('should return the correct service for a provider', () => {
      const anthropicService = service.getProviderService('anthropic');
      const openrouterService = service.getProviderService('openrouter');
      const invalidService = service.getProviderService('invalid');

      expect(anthropicService).toBe(mockAnthropicService);
      expect(openrouterService).toBe(mockOpenRouterService);
      expect(invalidService).toBeNull();
    });
  });

  describe('getAllAvailableModels', () => {
    it('should return models from all enabled providers', () => {
      const models = service.getAllAvailableModels();
      expect(models.length).toBeGreaterThan(0);
      
      // Should include models from anthropic, google, and openrouter (but not openai)
      const providers = [...new Set(models.map(m => m.provider))];
      expect(providers).toContain('anthropic');
      expect(providers).toContain('google');
      expect(providers).toContain('openrouter');
      expect(providers).not.toContain('openai');
    });
  });

  describe('getDefaultModel', () => {
    it('should return the first available model', () => {
      const defaultModel = service.getDefaultModel();
      expect(defaultModel).toBeDefined();
      expect(defaultModel?.provider).toBe('anthropic'); // First in the list
    });
  });

  describe('isProviderEnabled', () => {
    it('should correctly identify enabled providers', () => {
      expect(service.isProviderEnabled('anthropic')).toBe(true);
      expect(service.isProviderEnabled('openai')).toBe(false);
      expect(service.isProviderEnabled('google')).toBe(true);
      expect(service.isProviderEnabled('openrouter')).toBe(true);
      expect(service.isProviderEnabled('invalid')).toBe(false);
    });
  });

  describe('testProvider', () => {
    it('should return false for disabled providers', async () => {
      const result = await service.testProvider('openai');
      expect(result).toBe(false);
    });

    it('should call healthCheck if available', async () => {
      const result = await service.testProvider('openrouter');
      expect(result).toBe(true);
      expect(mockOpenRouterService.healthCheck).toHaveBeenCalled();
    });

    it('should return true for enabled providers without healthCheck', async () => {
      const result = await service.testProvider('anthropic');
      expect(result).toBe(true);
    });
  });
});