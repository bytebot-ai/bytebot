import { TemporalCapabilityProbeService } from './temporal-capability-probe.service';

describe('TemporalCapabilityProbeService', () => {
  function createService(params: {
    temporalEnabled: boolean;
    mode?: 'REACHABILITY' | 'UPDATE';
    updateAccepted?: boolean;
  }) {
    const okGauge = { set: jest.fn() } as any;
    const failuresCounter = { inc: jest.fn() } as any;

    const handle = {
      executeUpdate: jest.fn(async () => ({
        accepted: params.updateAccepted ?? true,
        applied: true,
      })),
    };

    const client = {
      workflowService: { getSystemInfo: jest.fn(async () => ({})) },
      workflow: {
        start: jest.fn(async () => ({})),
        getHandle: jest.fn(() => handle),
      },
    } as any;

    const configService = {
      get: jest.fn((key: string, defaultValue?: string) => {
        if (key === 'TEMPORAL_WORKFLOW_ENABLED') return params.temporalEnabled ? 'true' : 'false';
        if (key === 'TEMPORAL_CAPABILITY_PROBE_MODE') return params.mode ?? defaultValue ?? 'REACHABILITY';
        if (key === 'TEMPORAL_TASK_QUEUE') return 'bytebot-goal-runs';
        if (key === 'POD_NAME') return 'pod-1';
        return defaultValue;
      }),
    } as any;

    return {
      service: new TemporalCapabilityProbeService(client, configService, okGauge, failuresCounter),
      okGauge,
      failuresCounter,
      client,
      handle,
      configService,
    };
  }

  it('sets disabled when Temporal is off', async () => {
    const { service, okGauge, failuresCounter, client } = createService({ temporalEnabled: false });

    await service.probeOnce();

    expect(okGauge.set).toHaveBeenCalledWith(0);
    expect(failuresCounter.inc).not.toHaveBeenCalled();
    expect(client.workflowService.getSystemInfo).not.toHaveBeenCalled();
  });

  it('runs reachability probe by default', async () => {
    const { service, client, okGauge } = createService({ temporalEnabled: true, mode: 'REACHABILITY' });

    await service.probeOnce();

    expect(client.workflowService.getSystemInfo).toHaveBeenCalled();
    expect(okGauge.set).toHaveBeenCalledWith(1);
  });

  it('runs UPDATE probe when configured and fails closed if update is not accepted', async () => {
    const { service, client, handle, okGauge, failuresCounter } = createService({
      temporalEnabled: true,
      mode: 'UPDATE',
      updateAccepted: false,
    });

    await service.probeOnce();

    expect(client.workflow.start).toHaveBeenCalled();
    expect(handle.executeUpdate).toHaveBeenCalled();
    expect(okGauge.set).toHaveBeenCalledWith(0);
    expect(failuresCounter.inc).toHaveBeenCalled();
  });
});

