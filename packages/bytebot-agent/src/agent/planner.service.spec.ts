import { Test, TestingModule } from '@nestjs/testing';
import { PlannerService } from './planner.service';
import { AnthropicService } from '../anthropic/anthropic.service';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import { ProxyService } from '../proxy/proxy.service';
import { Task, Message, Role } from '@prisma/client';
import { MessageContentType } from '@bytebot/shared';

describe('PlannerService', () => {
  let service: PlannerService;
  let anthropicService: AnthropicService;

  const mockTask: Task = {
    id: 'test-task',
    description: 'Test task description',
    model: { provider: 'anthropic', name: 'claude-3-opus-20240229' },
    // Add other required Task properties with dummy values
    type: 'IMMEDIATE',
    status: 'PENDING',
    priority: 'MEDIUM',
    control: 'ASSISTANT',
    createdAt: new Date(),
    createdBy: 'USER',
    updatedAt: new Date(),
    executedAt: null,
    completedAt: null,
    queuedAt: null,
    error: null,
    result: null,
    plan: null,
    planStep: 0,
    scheduledFor: null,
  };

  const mockMessage: Message = {
    id: 'test-message',
    content: [{ type: MessageContentType.Text, text: 'Initial user request' }],
    role: Role.USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    taskId: 'test-task',
    summaryId: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlannerService,
        {
          provide: AnthropicService,
          useValue: {
            generateMessage: jest.fn(),
          },
        },
        { provide: OpenAIService, useValue: { generateMessage: jest.fn() } },
        { provide: GoogleService, useValue: { generateMessage: jest.fn() } },
        { provide: ProxyService, useValue: { generateMessage: jest.fn() } },
      ],
    }).compile();

    service = module.get<PlannerService>(PlannerService);
    anthropicService = module.get<AnthropicService>(AnthropicService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate a plan from a valid JSON response', async () => {
    const mockPlan = ['Step 1', 'Step 2'];
    const mockResponse = {
      contentBlocks: [{ type: MessageContentType.Text, text: JSON.stringify(mockPlan) }],
      tokenUsage: { totalTokens: 100 },
    };
    (anthropicService.generateMessage as jest.Mock).mockResolvedValue(mockResponse);

    const plan = await service.generatePlan(mockTask, mockMessage);

    expect(plan).toEqual(mockPlan);
    expect(anthropicService.generateMessage).toHaveBeenCalled();
  });

  it('should handle a non-JSON response gracefully', async () => {
    const mockPlanText = 'This is not JSON';
    const mockResponse = {
      contentBlocks: [{ type: MessageContentType.Text, text: mockPlanText }],
      tokenUsage: { totalTokens: 100 },
    };
    (anthropicService.generateMessage as jest.Mock).mockResolvedValue(mockResponse);

    const plan = await service.generatePlan(mockTask, mockMessage);

    expect(plan).toEqual([mockPlanText]);
  });

  it('should handle an empty response', async () => {
    const mockResponse = {
      contentBlocks: [],
      tokenUsage: { totalTokens: 100 },
    };
    (anthropicService.generateMessage as jest.Mock).mockResolvedValue(mockResponse);

    const plan = await service.generatePlan(mockTask, mockMessage);

    expect(plan).toEqual([]);
  });
});
