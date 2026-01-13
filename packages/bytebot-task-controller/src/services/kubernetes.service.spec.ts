import { ConfigService } from '@nestjs/config';
import { KubernetesService } from './kubernetes.service';

describe(KubernetesService.name, () => {
  function createService() {
    const configService = {
      get: jest.fn(),
    } as unknown as ConfigService;

    const service = new KubernetesService(configService);
    (service as any).namespace = 'bytebot';

    const coreApi = {
      createNamespacedPod: jest.fn().mockResolvedValue({ body: { metadata: {}, status: {} } }),
      listNamespacedPod: jest.fn().mockResolvedValue({ body: { items: [] } }),
    };
    (service as any).coreApi = coreApi;

    jest.spyOn(service, 'getPod').mockResolvedValue(null);

    return { service, coreApi };
  }

  it('creates a workspace pod with a persistent PVC volume when persistence is enabled', async () => {
    const { service, coreApi } = createService();

    await service.createWorkspacePod(
      'ws-abc123',
      'tenant-1',
      { enabled: true, storageClass: 'ceph-rbd', size: '10Gi', mounts: [] },
      'desktop-image',
    );

    expect(coreApi.createNamespacedPod).toHaveBeenCalledTimes(1);
    const pod = (coreApi.createNamespacedPod as jest.Mock).mock.calls[0][1];

    const workspaceVolume = pod.spec.volumes.find((v: any) => v.name === 'workspace-storage');
    expect(workspaceVolume).toBeTruthy();
    expect(workspaceVolume.persistentVolumeClaim?.claimName).toContain('workspace-');
    expect(workspaceVolume.ephemeral).toBeUndefined();

    const mounts = pod.spec.containers[0].volumeMounts;
    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'workspace-storage', mountPath: '/tmp', subPath: 'tmp' }),
        expect.objectContaining({
          name: 'workspace-storage',
          mountPath: '/home/user/.cache',
          subPath: 'cache',
        }),
        expect.objectContaining({ name: 'workspace-storage', mountPath: '/var/log', subPath: 'varlog' }),
      ]),
    );
  });

  it('creates a workspace pod with a CSI ephemeral volume when persistence is disabled', async () => {
    const { service, coreApi } = createService();

    await service.createWorkspacePod(
      'ws-def456',
      'tenant-1',
      { enabled: false, storageClass: 'ceph-rbd', size: '10Gi', mounts: [] },
      'desktop-image',
    );

    expect(coreApi.createNamespacedPod).toHaveBeenCalledTimes(1);
    const pod = (coreApi.createNamespacedPod as jest.Mock).mock.calls[0][1];

    const workspaceVolume = pod.spec.volumes.find((v: any) => v.name === 'workspace-storage');
    expect(workspaceVolume).toBeTruthy();
    expect(workspaceVolume.persistentVolumeClaim).toBeUndefined();
    expect(workspaceVolume.ephemeral?.volumeClaimTemplate?.spec?.storageClassName).toBe('ceph-rbd');
  });

  it('lists only Running+Ready warm pods (and excludes terminating pods)', async () => {
    const { service, coreApi } = createService();

    (coreApi.listNamespacedPod as jest.Mock).mockResolvedValue({
      body: {
        items: [
          // Not running
          { status: { phase: 'Pending' } },
          // Running but not Ready
          {
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'False' }],
            },
          },
          // Running+Ready but terminating
          {
            metadata: { deletionTimestamp: new Date().toISOString() },
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
          // Running+Ready
          {
            metadata: { name: 'warm-0' },
            status: {
              phase: 'Running',
              conditions: [{ type: 'Ready', status: 'True' }],
            },
          },
        ],
      },
    });

    const pods = await service.listAvailableWarmPods({ 'bytebot.ai/pool': 'warm' });
    expect(pods).toHaveLength(1);
    expect(pods[0].metadata?.name).toBe('warm-0');
  });

  it('lists claimed desktop pods (assigned=true) and excludes terminating pods', async () => {
    const { service, coreApi } = createService();

    (coreApi.listNamespacedPod as jest.Mock).mockResolvedValue({
      body: {
        items: [
          { metadata: { name: 'claimed-0', deletionTimestamp: new Date().toISOString() } },
          { metadata: { name: 'claimed-1' } },
        ],
      },
    });

    const pods = await service.listClaimedDesktopPods();
    expect(pods).toHaveLength(1);
    expect(pods[0].metadata?.name).toBe('claimed-1');
  });

  it('clears desktop claims for a taskId by patching labels on matching pods', async () => {
    const { service, coreApi } = createService();

    (coreApi.listNamespacedPod as jest.Mock).mockResolvedValue({
      body: {
        items: [
          { metadata: { name: 'warm-2' } },
          { metadata: { name: 'warm-3', deletionTimestamp: new Date().toISOString() } },
        ],
      },
    });

    const clearSpy = jest
      .spyOn(service, 'clearPodLabels')
      .mockResolvedValue(undefined);

    const result = await service.clearDesktopClaimsForTask('task-1');
    expect(result.cleared).toBe(1);
    expect(result.podNames).toEqual(['warm-2']);
    expect(clearSpy).toHaveBeenCalledWith('warm-2', 'bytebot');
  });
});
