import { ConflictException } from '@nestjs/common';
import { Role, TaskPriority, TaskStatus, TaskType } from '@prisma/client';
import { TasksService } from './tasks.service';

describe('TasksService.takeOver', () => {
  const makeTask = (overrides: Partial<any> = {}) => {
    return {
      id: 't-1',
      description: 'test',
      title: null,
      type: TaskType.IMMEDIATE,
      status: TaskStatus.RUNNING,
      priority: TaskPriority.MEDIUM,
      control: Role.ASSISTANT,
      createdAt: new Date(),
      createdBy: Role.USER,
      scheduledFor: null,
      updatedAt: new Date(),
      executedAt: null,
      completedAt: null,
      queuedAt: null,
      error: null,
      result: null,
      model: { provider: 'openai', name: 'desktop-vision' },
      version: 0,
      claimedBy: null,
      leaseExpiresAt: null,
      workspaceId: null,
      nodeRunId: null,
      allowedTools: [],
      gatewayToolsOnly: false,
      highRiskTools: [],
      requiresDesktop: true,
      executionSurface: null,
      files: [],
      summaries: [],
      messages: [],
      artifacts: [],
      actionLogs: [],
      ...overrides,
    };
  };

  const makeService = (
    overrides: {
      prisma?: any;
      taskControllerService?: any;
      tasksGateway?: any;
      eventEmitter?: any;
    } = {},
  ) => {
    const prisma =
      overrides.prisma ||
      ({
        task: {
          findUnique: jest.fn(async () => makeTask()),
          update: jest.fn(async () => makeTask({ control: Role.USER })),
        },
      } as any);

    const tasksGateway =
      overrides.tasksGateway || ({ emitTaskUpdate: jest.fn() } as any);

    const configService = { get: jest.fn(() => '') } as any;
    const eventEmitter = overrides.eventEmitter || ({ emit: jest.fn() } as any);

    const taskControllerService =
      overrides.taskControllerService ||
      ({
        isPhase6Enabled: jest.fn(() => false),
        getDesktopUrl: jest.fn(async () => 'http://desktop'),
      } as any);

    const titleGenerationService = {} as any;

    return new TasksService(
      prisma,
      tasksGateway,
      configService,
      eventEmitter,
      taskControllerService,
      titleGenerationService,
    );
  };

  it('returns typed 409 and does not mutate task state when takeover is not available', async () => {
    const prisma = {
      task: {
        findUnique: jest.fn(async () => makeTask()),
        update: jest.fn(),
      },
    } as any;

    const taskControllerService = {
      isPhase6Enabled: jest.fn(() => true),
      getDesktopTakeoverAvailability: jest.fn(async () => ({
        ok: false,
        reason: 'DESKTOP_TIMED_OUT',
        details: { timeoutAt: '2026-01-22T00:00:00.000Z' },
      })),
    } as any;

    const tasksGateway = { emitTaskUpdate: jest.fn() } as any;
    const eventEmitter = { emit: jest.fn() } as any;

    const service = makeService({
      prisma,
      taskControllerService,
      tasksGateway,
      eventEmitter,
    });

    let thrown: any = null;
    try {
      await service.takeOver('t-1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown.getResponse()).toMatchObject({
      errorCode: 'TAKEOVER_NOT_AVAILABLE',
      details: { reason: 'DESKTOP_TIMED_OUT' },
    });

    expect(prisma.task.update).not.toHaveBeenCalled();
    expect(tasksGateway.emitTaskUpdate).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });
});
