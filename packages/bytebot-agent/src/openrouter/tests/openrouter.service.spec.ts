import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpenRouterService } from '../openrouter.service';
import { Message, Role } from '@prisma/client';
import { MessageContentType } from '@bytebot/shared';

// Mock fetch globally
global.fetch = jest.fn();

describe('OpenRouterService', () => {
  let service: OpenRouterService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpenRouterService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'OPENROUTER_API_KEY') {
                return 'test-api-key';
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<OpenRouterService>(OpenRouterService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return true when API is accessible', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
      });

      const result = await service.healthCheck();
      expect(result).toBe(true);
      expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', {
        headers: {
          Authorization: 'Bearer test-api-key',
          'HTTP-Referer': 'https://bytebot.ai',
          'X-Title': 'Bytebot Agent',
        },
      });
    });

    it('should return false when API is not accessible', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
      });

      const result = await service.healthCheck();
      expect(result).toBe(false);
    });

    it('should return false when fetch throws an error', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const result = await service.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('getAvailableModels', () => {
    it('should return list of available models', async () => {
      const mockModels = {
        data: [
          { id: 'anthropic/claude-3.5-sonnet' },
          { id: 'openai/gpt-4' },
        ],
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockModels),
      });

      const result = await service.getAvailableModels();
      expect(result).toEqual(['anthropic/claude-3.5-sonnet', 'openai/gpt-4']);
    });

    it('should return empty array on error', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('API error'));

      const result = await service.getAvailableModels();
      expect(result).toEqual([]);
    });
  });

  describe('generateMessage', () => {
    const mockMessage: Message = {
      id: '1',
      content: [
        {
          type: MessageContentType.Text,
          text: 'Hello, world!',
        },
      ],
      role: Role.USER,
      taskId: 'task-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should generate a response successfully', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'Hello! How can I help you today?',
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 8,
          total_tokens: 18,
        },
      };

      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValueOnce(mockResponse),
      });

      const result = await service.generateMessage(
        'You are a helpful assistant',
        [mockMessage],
        'anthropic/claude-3.5-sonnet',
        true,
      );

      expect(result.contentBlocks).toHaveLength(1);
      expect(result.contentBlocks[0]).toEqual({
        type: MessageContentType.Text,
        text: 'Hello! How can I help you today?',
      });
      expect(result.tokenUsage).toEqual({
        inputTokens: 10,
        outputTokens: 8,
        totalTokens: 18,
      });
    });

    it('should handle API errors', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      await expect(
        service.generateMessage(
          'You are a helpful assistant',
          [mockMessage],
          'anthropic/claude-3.5-sonnet',
          true,
        ),
      ).rejects.toThrow('Rate limit exceeded');
    });

    it('should handle network errors', async () => {
      const abortError = new Error('Request aborted');
      abortError.name = 'AbortError';
      (fetch as jest.Mock).mockRejectedValueOnce(abortError);

      await expect(
        service.generateMessage(
          'You are a helpful assistant',
          [mockMessage],
          'anthropic/claude-3.5-sonnet',
          true,
        ),
      ).rejects.toThrow('BytebotAgentInterrupt');
    });
  });

  describe('send', () => {
    it('should be an alias for generateMessage', async () => {
      const spy = jest.spyOn(service, 'generateMessage').mockResolvedValueOnce({
        contentBlocks: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

      await service.send('system', [], 'model', true);

      expect(spy).toHaveBeenCalledWith('system', [], 'model', true, undefined);
    });
  });
});