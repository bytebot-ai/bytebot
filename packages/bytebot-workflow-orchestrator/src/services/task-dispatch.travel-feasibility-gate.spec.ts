import { ExecutionSurface } from '@prisma/client';
import { TaskDispatchService } from './task-dispatch.service';

describe('TaskDispatchService travel feasibility gate', () => {
  it('auto-upgrades travel-shopping dispatches to DESKTOP with browser tool', async () => {
    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;
    const prisma = {} as any;
    const dbTransientService = {} as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const userPromptService = {} as any;
    const outboxService = {} as any;

    const service = new TaskDispatchService(
      configService,
      prisma,
      dbTransientService,
      eventEmitter,
      userPromptService,
      outboxService,
    );

    // Avoid real HTTP and side effects
    (service as any).httpClient = {
      post: jest.fn().mockResolvedValue({ status: 201, data: { id: 'task-1' } }),
    };
    jest.spyOn(service as any, 'emitActivityEvent').mockResolvedValue(undefined);

    await service.dispatchTask({
      goalRunId: 'gr-1',
      checklistItemId: 'ci-1',
      workspaceId: 'ws-1',
      title: 'Search flights',
      description: 'Search for flights from DTW to LAS',
      allowedTools: [],
      requiresDesktop: false,
      executionSurface: ExecutionSurface.TEXT_ONLY,
      goalContext: 'Please price a trip with flight and hotel from Detroit to Las Vegas Feb 21-28',
      previousStepResults: '',
      attempt: 1,
    });

    expect((service as any).httpClient.post).toHaveBeenCalledWith(
      '/tasks',
      expect.objectContaining({
        requiresDesktop: true,
        executionSurface: ExecutionSurface.DESKTOP,
        allowedTools: expect.arrayContaining(['browser']),
      }),
    );
  });
});

