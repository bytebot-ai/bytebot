import { TaskController } from './task.controller';

function makeDbTask(overrides: Partial<any> = {}) {
  return {
    id: 'task-1',
    description: 'test',
    type: 'IMMEDIATE',
    status: 'PENDING',
    priority: 'MEDIUM',
    control: 'ASSISTANT',
    requiresDesktop: false,
    executionSurface: 'TEXT_ONLY',
    model: {},
    version: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    tenantId: 'tenant-1',
    ...overrides,
  };
}

describe('TaskController (TEXT_ONLY gating)', () => {
  test('getTaskInfo returns TextOnly without provisioning TaskDesktop', async () => {
    const k8sService = {
      getTaskDesktopByTaskId: jest.fn().mockResolvedValue(null),
      getTaskCredentials: jest.fn(),
      createTaskDesktop: jest.fn(),
      listAvailableWarmPods: jest.fn(),
    } as any;

    const dbService = {
      getTask: jest.fn().mockResolvedValue(makeDbTask()),
      countPendingTasks: jest.fn(),
    } as any;

    const metricsService = {} as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;

    const controller = new TaskController(
      k8sService,
      dbService,
      metricsService,
      configService,
    );

    const result = await controller.getTaskInfo('task-1');

    expect(result.phase).toBe('TextOnly');
    expect(result.desktopEndpoint).toBeNull();
    expect(result.credentials).toBeNull();
    expect(k8sService.getTaskCredentials).not.toHaveBeenCalled();
    expect(dbService.countPendingTasks).not.toHaveBeenCalled();
    expect(k8sService.createTaskDesktop).not.toHaveBeenCalled();
  });

  test('postHeartbeat returns ready=true for TEXT_ONLY task without provisioning TaskDesktop', async () => {
    const k8sService = {
      getTaskDesktopByTaskId: jest.fn().mockResolvedValue(null),
      createTaskDesktop: jest.fn(),
      listAvailableWarmPods: jest.fn(),
      updateTaskDesktopStatus: jest.fn(),
    } as any;

    const dbService = {
      getTask: jest.fn().mockResolvedValue(makeDbTask()),
      countPendingTasks: jest.fn(),
    } as any;

    const metricsService = {} as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;

    const controller = new TaskController(
      k8sService,
      dbService,
      metricsService,
      configService,
    );

    const result = await controller.postHeartbeat('task-1', { taskId: 'task-1' });

    expect(result.acknowledged).toBe(true);
    expect(result.shouldContinue).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.phase).toBe('TextOnly');
    expect(dbService.countPendingTasks).not.toHaveBeenCalled();
    expect(k8sService.createTaskDesktop).not.toHaveBeenCalled();
    expect(k8sService.updateTaskDesktopStatus).not.toHaveBeenCalled();
  });

  test('getTaskHealth returns healthy response for TEXT_ONLY task without TaskDesktop', async () => {
    const k8sService = {
      getTaskDesktopByTaskId: jest.fn().mockResolvedValue(null),
    } as any;

    const dbService = {
      getTask: jest.fn().mockResolvedValue(makeDbTask()),
    } as any;

    const metricsService = {} as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;

    const controller = new TaskController(
      k8sService,
      dbService,
      metricsService,
      configService,
    );

    const result = await controller.getTaskHealth('task-1');

    expect(result.phase).toBe('TextOnly');
    expect(result.isHeartbeatHealthy).toBe(true);
    expect(result.agentHeartbeat).toBeNull();
  });
});

describe('TaskController (desktop cleanup orphan-safety)', () => {
  test('cleanupTaskDesktop releases orphan claims when TaskDesktop CR is missing', async () => {
    const k8sService = {
      getTaskDesktopByTaskId: jest.fn().mockResolvedValue(null),
      clearDesktopClaimsForTask: jest.fn().mockResolvedValue({ cleared: 1, podNames: ['warm-2'] }),
      deleteTaskSecret: jest.fn().mockResolvedValue(undefined),
    } as any;

    const dbService = {} as any;
    const metricsService = {
      incrementOrphanDesktopClaimsCleared: jest.fn(),
    } as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;

    const controller = new TaskController(
      k8sService,
      dbService,
      metricsService,
      configService,
    );

    const result = await controller.cleanupTaskDesktop('task-1');
    expect(result.cleaned).toBe(true);
    expect(k8sService.clearDesktopClaimsForTask).toHaveBeenCalledWith('task-1');
    expect(k8sService.deleteTaskSecret).toHaveBeenCalledWith('task-1');
    expect(metricsService.incrementOrphanDesktopClaimsCleared).toHaveBeenCalledWith(1);
  });

  test('cleanupTaskDesktop is idempotent when TaskDesktop CR missing and no orphan claims exist', async () => {
    const k8sService = {
      getTaskDesktopByTaskId: jest.fn().mockResolvedValue(null),
      clearDesktopClaimsForTask: jest.fn().mockResolvedValue({ cleared: 0, podNames: [] }),
      deleteTaskSecret: jest.fn().mockResolvedValue(undefined),
    } as any;

    const dbService = {} as any;
    const metricsService = {
      incrementOrphanDesktopClaimsCleared: jest.fn(),
    } as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;

    const controller = new TaskController(
      k8sService,
      dbService,
      metricsService,
      configService,
    );

    const result = await controller.cleanupTaskDesktop('task-1');
    expect(result.cleaned).toBe(true);
    expect(k8sService.clearDesktopClaimsForTask).toHaveBeenCalledWith('task-1');
    expect(metricsService.incrementOrphanDesktopClaimsCleared).not.toHaveBeenCalled();
  });
});
