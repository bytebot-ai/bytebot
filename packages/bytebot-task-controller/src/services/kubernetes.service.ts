/**
 * Kubernetes Service
 * Handles all Kubernetes API interactions
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as k8s from '@kubernetes/client-node';
import {
  TaskDesktop,
  TaskDesktopList,
  TaskDesktopStatus,
  PodClaimResult,
  WorkspaceCreateResult,
  PersistenceConfig,
  PersistenceMount,
  DEFAULT_PERSISTENCE_MOUNTS,
} from '../interfaces/taskdesktop.interface';
import {
  toWorkspacePVCName,
  toWorkspacePodName,
  validateWorkspaceId,
} from '../utils/dns-naming.util';

@Injectable()
export class KubernetesService implements OnModuleInit {
  private readonly logger = new Logger(KubernetesService.name);
  private kubeConfig: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private customApi: k8s.CustomObjectsApi;
  private coordinationApi: k8s.CoordinationV1Api;
  private namespace: string;

  // v1.0.13: Retry configuration for handling 409 Conflict errors
  private readonly retryConfig = {
    maxRetries: 5,
    initialDelayMs: 100,
    maxDelayMs: 5000,
    factor: 2.0,
    jitter: 0.1, // 10% jitter
  };

  constructor(private configService: ConfigService) {}

  /**
   * v1.0.13: Check if an error is a Kubernetes 409 Conflict error
   */
  private isConflictError(error: any): boolean {
    const statusCode = error?.response?.statusCode || error?.statusCode || error?.status;
    return statusCode === 409;
  }

  /**
   * v1.0.13: Sleep with exponential backoff and jitter
   * Jitter helps prevent thundering herd when multiple controllers retry simultaneously
   */
  private async sleepWithJitter(baseDelayMs: number): Promise<void> {
    const jitterRange = baseDelayMs * this.retryConfig.jitter;
    const jitter = (Math.random() * 2 - 1) * jitterRange; // -10% to +10%
    const actualDelay = Math.min(baseDelayMs + jitter, this.retryConfig.maxDelayMs);
    await new Promise((resolve) => setTimeout(resolve, actualDelay));
  }

  /**
   * Convert a Date to Kubernetes MicroTime format (microsecond precision)
   * K8s expects: 2006-01-02T15:04:05.000000Z
   * JS provides: 2025-12-06T19:20:53.944Z (milliseconds only)
   */
  private toMicroTime(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '.000000Z');
  }

  async onModuleInit() {
    this.kubeConfig = new k8s.KubeConfig();

    // Try in-cluster config first, fall back to default
    try {
      this.kubeConfig.loadFromCluster();
      this.logger.log('Loaded in-cluster Kubernetes configuration');
    } catch {
      this.kubeConfig.loadFromDefault();
      this.logger.log('Loaded default Kubernetes configuration');
    }

    this.coreApi = this.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.customApi = this.kubeConfig.makeApiClient(k8s.CustomObjectsApi);
    this.coordinationApi = this.kubeConfig.makeApiClient(k8s.CoordinationV1Api);

    this.namespace =
      this.configService.get<string>('WARM_POOL_NAMESPACE') || 'bytebot';
  }

  /**
   * Get the namespace for warm pool pods
   */
  getNamespace(): string {
    return this.namespace;
  }

  /**
   * List TaskDesktop resources
   */
  async listTaskDesktops(namespace?: string): Promise<TaskDesktopList> {
    const ns = namespace || this.namespace;
    const response = await this.customApi.listNamespacedCustomObject(
      'bytebot.ai',
      'v1alpha1',
      ns,
      'taskdesktops',
    );
    return response.body as unknown as TaskDesktopList;
  }

  /**
   * Get a specific TaskDesktop
   */
  async getTaskDesktop(
    name: string,
    namespace?: string,
  ): Promise<TaskDesktop | null> {
    try {
      const ns = namespace || this.namespace;
      const response = await this.customApi.getNamespacedCustomObject(
        'bytebot.ai',
        'v1alpha1',
        ns,
        'taskdesktops',
        name,
      );
      return response.body as unknown as TaskDesktop;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a TaskDesktop resource
   */
  async createTaskDesktop(
    taskDesktop: TaskDesktop,
    namespace?: string,
  ): Promise<TaskDesktop> {
    const ns = namespace || this.namespace;
    const response = await this.customApi.createNamespacedCustomObject(
      'bytebot.ai',
      'v1alpha1',
      ns,
      'taskdesktops',
      taskDesktop,
    );
    return response.body as unknown as TaskDesktop;
  }

  /**
   * Update TaskDesktop status with retry-on-conflict
   *
   * v1.0.13: Implements read-modify-write pattern with exponential backoff retry
   * on HTTP 409 Conflict errors. This handles optimistic concurrency control
   * when multiple controllers (on-demand path + reconciler) race to update status.
   *
   * @param name - TaskDesktop resource name
   * @param status - Status fields to merge into current status
   * @param namespace - Optional namespace override
   * @returns Updated TaskDesktop resource
   * @throws Error if resource not found or max retries exceeded
   */
  async updateTaskDesktopStatus(
    name: string,
    status: TaskDesktopStatus,
    namespace?: string,
  ): Promise<TaskDesktop> {
    const ns = namespace || this.namespace;
    let lastError: any;
    let delay = this.retryConfig.initialDelayMs;

    for (let attempt = 1; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        // Step 1: Fetch the latest version to get current resourceVersion
        const current = await this.getTaskDesktop(name, ns);
        if (!current) {
          throw new Error(`TaskDesktop ${name} not found`);
        }

        // Step 2: Merge status updates
        current.status = { ...current.status, ...status };

        // Step 3: Attempt to update status subresource
        const response = await this.customApi.replaceNamespacedCustomObjectStatus(
          'bytebot.ai',
          'v1alpha1',
          ns,
          'taskdesktops',
          name,
          current,
        );

        // Success!
        if (attempt > 1) {
          this.logger.log(
            `Successfully updated TaskDesktop ${name} status after ${attempt} attempts`,
          );
        }
        return response.body as unknown as TaskDesktop;

      } catch (error: any) {
        lastError = error;

        // Only retry on conflict errors
        if (!this.isConflictError(error)) {
          throw error;
        }

        // Don't retry after the last attempt
        if (attempt === this.retryConfig.maxRetries) {
          this.logger.error(
            `Failed to update TaskDesktop ${name} status after ${attempt} attempts: ` +
            `conflict not resolved (resourceVersion mismatch)`,
          );
          break;
        }

        // Log retry attempt
        this.logger.warn(
          `Conflict updating TaskDesktop ${name} status (attempt ${attempt}/${this.retryConfig.maxRetries}), ` +
          `retrying in ${Math.round(delay)}ms...`,
        );

        // Wait with exponential backoff + jitter
        await this.sleepWithJitter(delay);
        delay = Math.min(delay * this.retryConfig.factor, this.retryConfig.maxDelayMs);
      }
    }

    // Max retries exceeded
    throw lastError;
  }

  /**
   * Delete a TaskDesktop
   */
  async deleteTaskDesktop(name: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;
    await this.customApi.deleteNamespacedCustomObject(
      'bytebot.ai',
      'v1alpha1',
      ns,
      'taskdesktops',
      name,
    );
  }

  /**
   * Patch TaskDesktop finalizers
   * Used to remove finalizers after cleanup is complete
   */
  async patchTaskDesktopFinalizers(
    name: string,
    finalizers: string[],
    namespace?: string,
  ): Promise<void> {
    const ns = namespace || this.namespace;
    const patch = {
      metadata: {
        finalizers: finalizers.length > 0 ? finalizers : null,
      },
    };

    await this.customApi.patchNamespacedCustomObject(
      'bytebot.ai',
      'v1alpha1',
      ns,
      'taskdesktops',
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
    this.logger.log(`Patched finalizers for TaskDesktop ${name}`);
  }

  /**
   * List available warm pool pods
   */
  async listAvailableWarmPods(
    selector: Record<string, string>,
    namespace?: string,
  ): Promise<k8s.V1Pod[]> {
    const ns = namespace || this.namespace;
    const labelSelector = Object.entries(selector)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    const response = await this.coreApi.listNamespacedPod(
      ns,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector,
    );

    return response.body.items.filter((pod) => {
      if (pod.metadata?.deletionTimestamp) {
        return false;
      }

      const isRunning = pod.status?.phase === 'Running';
      const isReady =
        pod.status?.conditions?.some(
          (c) => c.type === 'Ready' && c.status === 'True',
        ) ?? false;

      return isRunning && isReady;
    });
  }

  /**
   * List claimed desktop pods (assigned=true) for desktop-ephemeral pools.
   *
   * NOTE: This intentionally does NOT filter by readiness; it is used for
   * orphan-claim cleanup and must see broken pods as well.
   */
  async listClaimedDesktopPods(namespace?: string): Promise<k8s.V1Pod[]> {
    const ns = namespace || this.namespace;

    const response = await this.coreApi.listNamespacedPod(
      ns,
      undefined,
      undefined,
      undefined,
      undefined,
      [
        'app.kubernetes.io/name=bytebot-desktop-ephemeral',
        'bytebot.ai/assigned=true',
      ].join(','),
    );

    return response.body.items.filter((pod) => !pod.metadata?.deletionTimestamp);
  }

  /**
   * Clear desktop assignment labels for a given taskId.
   *
   * This is used as a safety fallback when the TaskDesktop CR is missing or
   * its status does not contain enough linkage to release the claimed pod.
   */
  async clearDesktopClaimsForTask(
    taskId: string,
    namespace?: string,
  ): Promise<{ cleared: number; podNames: string[] }> {
    const ns = namespace || this.namespace;

    const response = await this.coreApi.listNamespacedPod(
      ns,
      undefined,
      undefined,
      undefined,
      undefined,
      [
        'app.kubernetes.io/name=bytebot-desktop-ephemeral',
        `bytebot.ai/task-id=${taskId}`,
        'bytebot.ai/assigned=true',
      ].join(','),
    );

    const podNames: string[] = [];
    for (const pod of response.body.items) {
      if (pod.metadata?.deletionTimestamp) {
        continue;
      }

      const podName = pod.metadata?.name;
      if (!podName) {
        continue;
      }

      await this.clearPodLabels(podName, ns);
      podNames.push(podName);
    }

    return { cleared: podNames.length, podNames };
  }

  /**
   * Preflight check for a claimed desktop pod.
   *
   * We treat any HTTP response as "reachable" (bytebotd returns 404 on / in v2.0.29).
   */
  async preflightDesktopDaemon(
    podIP: string | undefined,
    port: number = 9990,
    timeoutMs: number = 1000,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!podIP) {
      return { ok: false, error: 'missing_pod_ip' };
    }

    const url = `http://${podIP}:${port}/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await fetch(url, { signal: controller.signal });
      return { ok: true };
    } catch (error: any) {
      const message = error?.message || String(error);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Claim a pod and ensure the desktop daemon is reachable before returning success.
   *
   * This prevents returning broken desktops when the allocator uses Pod IPs directly.
   */
  async claimPodWithDesktopPreflight(
    podName: string,
    taskId: string,
    tenantId: string,
    taskDesktopName: string,
    namespace?: string,
  ): Promise<PodClaimResult> {
    const ns = namespace || this.namespace;
    const claimResult = await this.claimPod(
      podName,
      taskId,
      tenantId,
      taskDesktopName,
      ns,
    );

    if (!claimResult.success) {
      return claimResult;
    }

    const preflight = await this.preflightDesktopDaemon(claimResult.podIP);
    if (preflight.ok) {
      return claimResult;
    }

    this.logger.warn(
      `Preflight failed for claimed pod ${claimResult.podName} (${claimResult.podIP}): ${preflight.error}`,
    );

    if (claimResult.podName && claimResult.podUID) {
      await this.releasePodWithUID(claimResult.podName, claimResult.podUID, ns);
    }

    return {
      success: false,
      error: 'desktop_preflight_failed',
    };
  }

  /**
   * Claim a pod for a task with atomic verification.
   *
   * v1.0.8: Added pre-check and post-verification to prevent race conditions
   * where multiple controller replicas could claim the same or different pods
   * for the same task.
   *
   * Flow:
   * 1. GET pod to check current state
   * 2. If already assigned, return failure immediately
   * 3. Apply claim labels via PATCH
   * 4. Verify our claim succeeded (our taskId is set)
   */
  async claimPod(
    podName: string,
    taskId: string,
    tenantId: string,
    taskDesktopName: string,
    namespace?: string,
  ): Promise<PodClaimResult> {
    const ns = namespace || this.namespace;

    try {
      // Step 1: Pre-check - verify pod is not already assigned
      const existingPod = await this.getPod(podName, ns);
      if (!existingPod) {
        this.logger.warn(`Pod ${podName} not found during claim attempt`);
        return {
          success: false,
          error: 'pod_not_found',
        };
      }

      const currentAssigned = existingPod.metadata?.labels?.['bytebot.ai/assigned'];
      const currentTaskId = existingPod.metadata?.labels?.['bytebot.ai/task-id'];

      // If already assigned to a different task, fail fast
      if (currentAssigned === 'true' && currentTaskId && currentTaskId !== taskId) {
        this.logger.warn(
          `Pod ${podName} already assigned to task ${currentTaskId}, cannot claim for ${taskId}`
        );
        return {
          success: false,
          error: 'pod_already_claimed',
        };
      }

      // If already assigned to THIS task (idempotent), return success
      if (currentAssigned === 'true' && currentTaskId === taskId) {
        this.logger.debug(`Pod ${podName} already claimed for task ${taskId} (idempotent)`);
        return {
          success: true,
          podName: existingPod.metadata?.name,
          podIP: existingPod.status?.podIP,
          podUID: existingPod.metadata?.uid,
        };
      }

      // Step 2: Apply claim labels
      const patch = {
        metadata: {
          labels: {
            'bytebot.ai/assigned': 'true',
            'bytebot.ai/routable': 'true',
            'bytebot.ai/task-id': taskId,
            'bytebot.ai/tenant-id': tenantId,
            'bytebot.ai/taskdesktop': taskDesktopName,
          },
          annotations: {
            'bytebot.ai/claimed-at': new Date().toISOString(),
            'bytebot.ai/claimed-by': taskDesktopName,
          },
        },
      };

      const options = {
        headers: { 'Content-Type': 'application/strategic-merge-patch+json' },
      };

      await this.coreApi.patchNamespacedPod(
        podName,
        ns,
        patch,
        undefined,
        undefined,
        'bytebot-task-controller',
        undefined,
        undefined,
        options,
      );

      // Step 3: Post-verification - ensure our claim won the race
      const verifyPod = await this.getPod(podName, ns);
      if (!verifyPod) {
        this.logger.error(`Pod ${podName} disappeared after claim patch`);
        return {
          success: false,
          error: 'pod_disappeared',
        };
      }

      const verifyTaskId = verifyPod.metadata?.labels?.['bytebot.ai/task-id'];
      if (verifyTaskId !== taskId) {
        // Another controller overwrote our claim - this is a race condition
        this.logger.warn(
          `Race condition: Pod ${podName} claimed by task ${verifyTaskId}, not ${taskId}`
        );
        return {
          success: false,
          error: 'claim_race_lost',
        };
      }

      this.logger.log(`Successfully claimed pod ${podName} for task ${taskId}`);
      return {
        success: true,
        podName: verifyPod.metadata?.name,
        podIP: verifyPod.status?.podIP,
        podUID: verifyPod.metadata?.uid,
      };
    } catch (error: any) {
      this.logger.error(`Failed to claim pod ${podName}: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Release a claimed pod (unclaim or delete)
   */
  async releasePod(podName: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;

    try {
      // For ephemeral pods, we delete them
      await this.coreApi.deleteNamespacedPod(podName, ns);
      this.logger.log(`Deleted pod ${podName}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        this.logger.warn(`Pod ${podName} already deleted`);
        return;
      }
      throw error;
    }
  }

  /**
   * Release a claimed pod with UID precondition
   * This ensures we only delete the specific pod instance, not a replacement
   * that may have been created with the same name by StatefulSet
   *
   * @param podName - Name of the pod to delete
   * @param expectedUID - The UID of the pod we expect to delete
   * @returns true if deleted, false if UID mismatch (replacement exists)
   */
  async releasePodWithUID(
    podName: string,
    expectedUID: string,
    namespace?: string,
  ): Promise<{ deleted: boolean; reason: string }> {
    const ns = namespace || this.namespace;

    try {
      // First, get the current pod and verify UID
      const pod = await this.getPod(podName, ns);

      if (!pod) {
        // Pod already deleted - treat as success
        this.logger.log(`Pod ${podName} already deleted (not found)`);
        return { deleted: true, reason: 'already_deleted' };
      }

      const currentUID = pod.metadata?.uid;
      if (currentUID !== expectedUID) {
        // UID mismatch - a replacement pod exists with the same name
        // This is expected for StatefulSets - don't delete the replacement!
        // v1.0.8: Clear stale labels from the replacement pod to prevent pool exhaustion
        this.logger.warn(
          `Pod ${podName} has been replaced (expected UID: ${expectedUID}, current UID: ${currentUID}). ` +
          `Clearing labels on replacement pod instead of deleting.`
        );
        await this.clearPodLabels(podName, ns);
        return { deleted: false, reason: 'uid_mismatch_labels_cleared' };
      }

      // UIDs match - safe to delete
      // Use delete with preconditions for extra safety
      const deleteOptions: k8s.V1DeleteOptions = {
        preconditions: {
          uid: expectedUID,
        },
      };

      await this.coreApi.deleteNamespacedPod(podName, ns, undefined, undefined, undefined, undefined, undefined, deleteOptions);
      this.logger.log(`Deleted pod ${podName} (UID: ${expectedUID})`);
      return { deleted: true, reason: 'deleted' };
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Pod deleted between our check and delete - treat as success
        this.logger.log(`Pod ${podName} deleted during operation (not found)`);
        return { deleted: true, reason: 'already_deleted' };
      }
      if (error.statusCode === 409) {
        // Conflict - UID changed between check and delete (race condition)
        this.logger.warn(`Pod ${podName} was replaced during delete operation (conflict)`);
        return { deleted: false, reason: 'uid_mismatch' };
      }
      throw error;
    }
  }

  /**
   * Clear assignment labels from a pod without deleting it.
   * Used when the pod was replaced by StatefulSet or when cleanup needs
   * to reset labels without triggering pod deletion.
   *
   * v1.0.8: Added to fix stale label issue where pods remain marked as
   * assigned after UID mismatch scenarios.
   */
  async clearPodLabels(podName: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;

    // Use JSON Patch to explicitly remove labels and annotations
    // null values in strategic-merge-patch remove the keys
    const patch = {
      metadata: {
        labels: {
          'bytebot.ai/assigned': 'false',
          'bytebot.ai/routable': 'false',
          'bytebot.ai/task-id': null,
          'bytebot.ai/tenant-id': null,
          'bytebot.ai/taskdesktop': null,
        },
        annotations: {
          'bytebot.ai/claimed-at': null,
          'bytebot.ai/claimed-by': null,
        },
      },
    };

    try {
      await this.coreApi.patchNamespacedPod(
        podName,
        ns,
        patch,
        undefined,
        undefined,
        'bytebot-task-controller',
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
      );
      this.logger.log(`Cleared assignment labels from pod ${podName}`);
    } catch (error: any) {
      if (error.statusCode === 404) {
        this.logger.warn(`Pod ${podName} not found when clearing labels (already deleted)`);
        return;
      }
      this.logger.error(`Failed to clear labels from pod ${podName}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get pod details
   */
  async getPod(podName: string, namespace?: string): Promise<k8s.V1Pod | null> {
    const ns = namespace || this.namespace;
    try {
      const response = await this.coreApi.readNamespacedPod(podName, ns);
      return response.body;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update a secret for task credentials
   */
  async createTaskSecret(
    taskId: string,
    tenantId: string,
    credentials: { vncPassword: string; apiToken: string },
    namespace?: string,
  ): Promise<string> {
    const ns = namespace || this.namespace;
    const secretName = `task-${taskId}-credentials`;

    const secret: k8s.V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: ns,
        labels: {
          'bytebot.ai/task-id': taskId,
          'bytebot.ai/tenant-id': tenantId,
          'bytebot.ai/component': 'task-credentials',
        },
      },
      type: 'Opaque',
      stringData: {
        'vnc-password': credentials.vncPassword,
        'api-token': credentials.apiToken,
      },
    };

    try {
      await this.coreApi.createNamespacedSecret(ns, secret);
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Already exists, update it
        await this.coreApi.replaceNamespacedSecret(secretName, ns, secret);
      } else {
        throw error;
      }
    }

    return secretName;
  }

  /**
   * Delete task secret
   */
  async deleteTaskSecret(taskId: string, namespace?: string): Promise<void> {
    const ns = namespace || this.namespace;
    const secretName = `task-${taskId}-credentials`;

    try {
      await this.coreApi.deleteNamespacedSecret(secretName, ns);
    } catch (error: any) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }
  }

  /**
   * Create or acquire a lease for leader election
   */
  async acquireLease(
    leaseName: string,
    identity: string,
    leaseDurationSeconds: number,
    namespace?: string,
  ): Promise<boolean> {
    const ns = namespace || this.namespace;
    const now = new Date();

    try {
      // Try to get existing lease
      const response = await this.coordinationApi.readNamespacedLease(
        leaseName,
        ns,
      );
      const lease = response.body;

      // Check if we already hold it or it's expired
      const renewTime = lease.spec?.renewTime
        ? new Date(lease.spec.renewTime as unknown as string)
        : null;
      const leaseDuration = lease.spec?.leaseDurationSeconds || 15;
      const holder = lease.spec?.holderIdentity;

      const isExpired =
        renewTime &&
        now.getTime() - renewTime.getTime() > leaseDuration * 1000;
      const isOurs = holder === identity;

      if (isOurs || isExpired || !holder) {
        // Acquire or renew - use proper MicroTime format
        const microTimeNow = this.toMicroTime(now);
        lease.spec = {
          ...lease.spec,
          holderIdentity: identity,
          leaseDurationSeconds,
          renewTime: microTimeNow as unknown as k8s.V1MicroTime,
          acquireTime: isOurs
            ? lease.spec?.acquireTime
            : (microTimeNow as unknown as k8s.V1MicroTime),
        };

        await this.coordinationApi.replaceNamespacedLease(leaseName, ns, lease);
        return true;
      }

      return false;
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Create new lease - use proper MicroTime format
        const microTimeNow = this.toMicroTime(now);
        const lease: k8s.V1Lease = {
          apiVersion: 'coordination.k8s.io/v1',
          kind: 'Lease',
          metadata: {
            name: leaseName,
            namespace: ns,
          },
          spec: {
            holderIdentity: identity,
            leaseDurationSeconds,
            acquireTime: microTimeNow as unknown as k8s.V1MicroTime,
            renewTime: microTimeNow as unknown as k8s.V1MicroTime,
          },
        };

        await this.coordinationApi.createNamespacedLease(ns, lease);
        return true;
      }
      throw error;
    }
  }

  /**
   * Renew existing lease
   */
  async renewLease(
    leaseName: string,
    identity: string,
    namespace?: string,
  ): Promise<boolean> {
    const ns = namespace || this.namespace;
    const now = new Date();

    try {
      const response = await this.coordinationApi.readNamespacedLease(
        leaseName,
        ns,
      );
      const lease = response.body;

      if (lease.spec?.holderIdentity !== identity) {
        return false;
      }

      // Use proper MicroTime format for renewal
      lease.spec.renewTime = this.toMicroTime(now) as unknown as k8s.V1MicroTime;
      await this.coordinationApi.replaceNamespacedLease(leaseName, ns, lease);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get TaskDesktop by taskId (searches by label)
   */
  async getTaskDesktopByTaskId(
    taskId: string,
    namespace?: string,
  ): Promise<TaskDesktop | null> {
    const ns = namespace || this.namespace;

    try {
      const response = await this.customApi.listNamespacedCustomObject(
        'bytebot.ai',
        'v1alpha1',
        ns,
        'taskdesktops',
        undefined,
        undefined,
        undefined,
        undefined,
        `bytebot.ai/task-id=${taskId}`,
      );

      const list = response.body as unknown as TaskDesktopList;
      if (list.items.length === 0) {
        return null;
      }

      return list.items[0];
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get task credentials from secret
   */
  async getTaskCredentials(
    taskId: string,
    namespace?: string,
  ): Promise<{ apiToken: string; vncPassword: string } | null> {
    const ns = namespace || this.namespace;
    const secretName = `task-${taskId}-credentials`;

    try {
      const response = await this.coreApi.readNamespacedSecret(secretName, ns);
      const secret = response.body;

      if (!secret.data) {
        return null;
      }

      return {
        apiToken: Buffer.from(secret.data['api-token'] || '', 'base64').toString('utf-8'),
        vncPassword: Buffer.from(secret.data['vnc-password'] || '', 'base64').toString('utf-8'),
      };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  // ==========================================================================
  // v1.0.15: Workspace Persistence Methods
  // ==========================================================================

  /**
   * v1.0.15: Create a PersistentVolumeClaim for workspace persistence
   *
   * Creates a single PVC that will be mounted with multiple subPaths for:
   * - Browser profile (chromium)
   * - Downloads directory
   * - Workspace/working directory
   *
   * @param workspaceId - Unique workspace identifier
   * @param config - Persistence configuration
   * @param namespace - Optional namespace override
   * @returns PVC name if created successfully
   */
  async createWorkspacePVC(
    workspaceId: string,
    config: PersistenceConfig,
    namespace?: string,
  ): Promise<{ success: boolean; pvcName?: string; error?: string }> {
    const ns = namespace || this.namespace;

    // v1.0.15: Use DNS-1123 safe naming
    const validation = validateWorkspaceId(workspaceId);
    if (!validation.valid) {
      return { success: false, error: `Invalid workspace ID: ${validation.error}` };
    }
    const pvcName = toWorkspacePVCName(workspaceId);

    // Check if PVC already exists (idempotent)
    try {
      const existingPVC = await this.getWorkspacePVC(workspaceId, ns);
      if (existingPVC) {
        this.logger.debug(`PVC ${pvcName} already exists (idempotent)`);
        return { success: true, pvcName };
      }
    } catch (error: any) {
      // Not found is expected, continue to create
      if (error.statusCode !== 404) {
        this.logger.error(`Error checking for existing PVC ${pvcName}: ${error.message}`);
      }
    }

    const storageClass = config.storageClass || 'longhorn';
    const size = config.size || '10Gi';

    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: ns,
        labels: {
          'bytebot.ai/workspace-id': workspaceId,
          'bytebot.ai/component': 'workspace-storage',
          'app.kubernetes.io/managed-by': 'bytebot-task-controller',
        },
        annotations: {
          'bytebot.ai/created-at': new Date().toISOString(),
          'bytebot.ai/storage-class': storageClass,
          'bytebot.ai/retain-on-delete': String(config.retainOnDelete || false),
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: storageClass,
        resources: {
          requests: {
            storage: size,
          },
        },
      },
    };

    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim(ns, pvc);
      this.logger.log(`Created PVC ${pvcName} (${size}, storageClass: ${storageClass})`);
      return { success: true, pvcName };
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Already exists (race condition) - treat as success
        this.logger.debug(`PVC ${pvcName} already exists (concurrent creation)`);
        return { success: true, pvcName };
      }
      this.logger.error(`Failed to create PVC ${pvcName}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * v1.0.15: Get workspace PVC details
   */
  async getWorkspacePVC(
    workspaceId: string,
    namespace?: string,
  ): Promise<k8s.V1PersistentVolumeClaim | null> {
    const ns = namespace || this.namespace;
    const pvcName = toWorkspacePVCName(workspaceId);

    try {
      const response = await this.coreApi.readNamespacedPersistentVolumeClaim(pvcName, ns);
      return response.body;
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * v1.0.15: Delete workspace PVC
   *
   * @param workspaceId - Workspace identifier
   * @param force - Delete even if retainOnDelete was set
   * @param namespace - Optional namespace override
   */
  async deleteWorkspacePVC(
    workspaceId: string,
    force: boolean = false,
    namespace?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const ns = namespace || this.namespace;
    const pvcName = toWorkspacePVCName(workspaceId);

    try {
      const pvc = await this.getWorkspacePVC(workspaceId, ns);
      if (!pvc) {
        this.logger.debug(`PVC ${pvcName} not found (already deleted)`);
        return { success: true };
      }

      // Check retain annotation unless force is set
      if (!force) {
        const retainOnDelete = pvc.metadata?.annotations?.['bytebot.ai/retain-on-delete'];
        if (retainOnDelete === 'true') {
          this.logger.log(`PVC ${pvcName} retained (retainOnDelete=true, use force to override)`);
          return { success: true };
        }
      }

      await this.coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, ns);
      this.logger.log(`Deleted PVC ${pvcName}`);
      return { success: true };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return { success: true };
      }
      this.logger.error(`Failed to delete PVC ${pvcName}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * v1.0.15: Create a workspace pod with PVC mounts
   *
   * Creates a dedicated pod for workspace mode (not claimed from warm pool).
   * The pod includes:
   * - Init container to set up directory permissions
   * - Main desktop container with PVC subPath mounts
   * - Shared memory for browser rendering
   *
   * @param workspaceId - Unique workspace identifier
   * @param tenantId - Tenant identifier
   * @param config - Persistence configuration
   * @param desktopImage - Desktop container image
   * @param namespace - Optional namespace override
   */
  async createWorkspacePod(
    workspaceId: string,
    tenantId: string,
    config: PersistenceConfig,
    desktopImage?: string,
    namespace?: string,
  ): Promise<WorkspaceCreateResult> {
    const ns = namespace || this.namespace;

    // v1.0.15: Use DNS-1123 safe naming
    const podName = toWorkspacePodName(workspaceId);
    const pvcName = toWorkspacePVCName(workspaceId);
    const mounts = config.mounts || DEFAULT_PERSISTENCE_MOUNTS;
    const persistenceEnabled = config.enabled !== false;
    const storageClass =
      config.storageClass ||
      this.configService.get<string>('WORKSPACE_DEFAULT_STORAGE_CLASS', 'longhorn');
    const storageSize = config.size || '10Gi';

    // Check if pod already exists (idempotent)
    const existingPod = await this.getPod(podName, ns);
    if (existingPod) {
      this.logger.debug(`Pod ${podName} already exists (idempotent)`);
      return {
        success: true,
        podName,
        pvcName: persistenceEnabled ? pvcName : undefined,
        podIP: existingPod.status?.podIP,
        podUID: existingPod.metadata?.uid,
        desktopEndpoint: existingPod.status?.podIP
          ? `http://${existingPod.status.podIP}:9990`
          : undefined,
      };
    }

    // Build volume mounts for main container
    const volumeMounts: k8s.V1VolumeMount[] = [];

    // Use CSI storage for all hot-write paths:
    // - persistent PVC when enabled (workspace continuity)
    // - CSI ephemeral volume when disabled (avoids node-local DiskPressure)
    mounts.forEach((m) => {
      volumeMounts.push({
        name: 'workspace-storage',
        mountPath: m.mountPath,
        subPath: m.subPath,
      });
    });

    // Add shared memory mount for browser rendering (always needed)
    volumeMounts.push({
      name: 'dshm',
      mountPath: '/dev/shm',
    });

    // Keep hot write paths off the container root filesystem (PV-backed).
    volumeMounts.push(
      {
        name: 'workspace-storage',
        mountPath: '/tmp',
        subPath: 'tmp',
      },
      {
        name: 'workspace-storage',
        mountPath: '/home/user/.cache',
        subPath: 'cache',
      },
      {
        name: 'workspace-storage',
        mountPath: '/var/log',
        subPath: 'varlog',
      },
    );

    const image = desktopImage ||
      this.configService.get<string>('DESKTOP_IMAGE') ||
      'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest';

    // Build volumes array (conditional based on persistence)
    const volumes: k8s.V1Volume[] = [
      {
        name: 'dshm',
        emptyDir: {
          medium: 'Memory',
          sizeLimit: '2Gi',
        },
      },
    ];

    // Build init containers array (needed for subPath directory creation)
    const initContainers: k8s.V1Container[] = [];

    if (persistenceEnabled) {
      // Add PVC volume
      volumes.push({
        name: 'workspace-storage',
        persistentVolumeClaim: {
          claimName: pvcName,
        },
      });
    } else {
      // CSI ephemeral volume (per-pod PVC; deleted with pod)
      volumes.push({
        name: 'workspace-storage',
        ephemeral: {
          volumeClaimTemplate: {
            spec: {
              accessModes: ['ReadWriteOnce'],
              storageClassName: storageClass,
              resources: {
                requests: {
                  storage: storageSize,
                },
              },
            },
          },
        },
      });
    }

    // Build init container commands to create directories with correct permissions
    const initCommands = [
      'set -e',
      ...mounts.map((m) => `mkdir -p /mnt/data/${m.subPath}`),
      'mkdir -p /mnt/data/tmp /mnt/data/cache /mnt/data/varlog',
      'chown -R 1000:1000 /mnt/data',
      'chmod -R 755 /mnt/data',
    ];

    // Add init container
    initContainers.push({
      name: 'init-directories',
      image: 'busybox:1.36',
      command: ['sh', '-c', initCommands.join('\n')],
      securityContext: {
        runAsUser: 0, // Root needed to set permissions
      },
      volumeMounts: [
        {
          name: 'workspace-storage',
          mountPath: '/mnt/data',
        },
      ],
    });

    const pod: k8s.V1Pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: ns,
        labels: {
          'bytebot.ai/workspace-id': workspaceId,
          'bytebot.ai/tenant-id': tenantId,
          'bytebot.ai/component': 'workspace-desktop',
          'bytebot.ai/pool': 'workspace', // Not from warm pool
          'bytebot.ai/assigned': 'true',
          'bytebot.ai/routable': 'true',
          'app.kubernetes.io/managed-by': 'bytebot-task-controller',
        },
        annotations: {
          'bytebot.ai/created-at': new Date().toISOString(),
          'bytebot.ai/persistence-enabled': String(persistenceEnabled),
        },
      },
      spec: {
        // Security context for the pod - matches warm pool configuration
        // Desktop image uses supervisord which requires root initially
        securityContext: {
          fsGroup: 1000,
          fsGroupChangePolicy: 'OnRootMismatch',
          runAsNonRoot: false,
        },
        // Node selector - MUST match warm pool to ensure CPU compatibility
        // The sharp module requires x86_64-v2 instructions (SSE4.2, POPCNT, AVX)
        // Only nodes with bytebot.ai/desktop-capable=true have compatible CPUs
        nodeSelector: {
          'bytebot.ai/desktop-capable': 'true',
          'kubernetes.io/os': 'linux',
        },
        // Init containers (only present when persistence enabled)
        initContainers: initContainers.length > 0 ? initContainers : undefined,
        containers: [
          {
            name: 'desktop',
            image,
            // NOTE: Do NOT specify args without command - it overrides the image entrypoint
            // If custom chromium flags needed, use CHROMIUM_FLAGS env var instead
            // Security context for container - matches warm pool (privileged for supervisord)
            securityContext: {
              privileged: true,
              allowPrivilegeEscalation: true,
              runAsNonRoot: false,
            },
            ports: [
              { containerPort: 9990, name: 'desktop', protocol: 'TCP' },
              { containerPort: 5900, name: 'vnc', protocol: 'TCP' },
              { containerPort: 6080, name: 'vnc-ws', protocol: 'TCP' },
            ],
            volumeMounts,
            // v1.0.22: Reduced resource requests to improve cluster capacity
            // Desktop pods can run with less, and we can burst to limits if needed
            resources: {
              requests: {
                memory: '1Gi',
                cpu: '500m',
                'ephemeral-storage': '5Gi',
              },
              limits: {
                memory: '3Gi',
                cpu: '1500m',
                'ephemeral-storage': '15Gi',
              },
            },
            env: [
              { name: 'DISPLAY', value: ':1' },
              { name: 'VNC_PASSWORD', value: 'bytebot' }, // Default, should be overridden
            ],
            // NOTE: Probes removed to match warm pool configuration
            // The bytebotd service has intermittent sharp module issues that cause
            // it to crash and restart via supervisord. Without probes, the pod
            // stays running and the agent can still execute tasks.
            // The orchestrator polls for task completion, so pod health isn't critical.
          },
        ],
        volumes,
        // Use Always restart policy to match warm pool behavior
        // This allows supervisord to restart if it crashes (e.g., sharp module issue)
        restartPolicy: 'Always',
        terminationGracePeriodSeconds: 30,
        // v1.0.23: High priority ensures workspace pods preempt pool pods if needed
        // This prevents workspace starvation when pool pods are over-reserving capacity
        priorityClassName: 'bytebot-workspace-high',
      },
    };

    try {
      const response = await this.coreApi.createNamespacedPod(ns, pod);
      const createdPod = response.body;
      this.logger.log(
        `Created workspace pod ${podName}` +
        (persistenceEnabled ? ` with PVC ${pvcName}` : ' (no persistence)')
      );

      return {
        success: true,
        podName,
        pvcName: persistenceEnabled ? pvcName : undefined,
        podIP: createdPod.status?.podIP,
        podUID: createdPod.metadata?.uid,
      };
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Already exists (race condition) - get existing
        const existingPod = await this.getPod(podName, ns);
        if (existingPod) {
          return {
            success: true,
            podName,
            pvcName: persistenceEnabled ? pvcName : undefined,
            podIP: existingPod.status?.podIP,
            podUID: existingPod.metadata?.uid,
          };
        }
      }
      this.logger.error(`Failed to create workspace pod ${podName}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * v1.0.15: Delete workspace pod
   *
   * Deletes the workspace pod. The PVC is handled separately based on retainOnDelete.
   */
  async deleteWorkspacePod(
    workspaceId: string,
    namespace?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const ns = namespace || this.namespace;
    const podName = toWorkspacePodName(workspaceId);

    try {
      await this.coreApi.deleteNamespacedPod(podName, ns);
      this.logger.log(`Deleted workspace pod ${podName}`);
      return { success: true };
    } catch (error: any) {
      if (error.statusCode === 404) {
        return { success: true };
      }
      this.logger.error(`Failed to delete workspace pod ${podName}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * v1.0.15: Get workspace pod status
   */
  async getWorkspacePod(
    workspaceId: string,
    namespace?: string,
  ): Promise<k8s.V1Pod | null> {
    const ns = namespace || this.namespace;
    const podName = toWorkspacePodName(workspaceId);
    return this.getPod(podName, ns);
  }

  /**
   * v1.0.15: Wait for workspace pod to be ready
   *
   * Polls the pod status until it's Running and ready, or times out.
   *
   * @param workspaceId - Workspace identifier
   * @param timeoutMs - Maximum time to wait (default: 120s)
   * @param pollIntervalMs - Polling interval (default: 2s)
   */
  async waitForWorkspacePodReady(
    workspaceId: string,
    timeoutMs: number = 120000,
    pollIntervalMs: number = 2000,
    namespace?: string,
  ): Promise<{ ready: boolean; podIP?: string; error?: string }> {
    const ns = namespace || this.namespace;
    const podName = toWorkspacePodName(workspaceId);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const pod = await this.getPod(podName, ns);

      if (!pod) {
        return { ready: false, error: 'pod_not_found' };
      }

      // Check if pod is Running
      if (pod.status?.phase === 'Running') {
        // Check if all containers are ready
        const allReady = pod.status.containerStatuses?.every((cs) => cs.ready) ?? false;
        if (allReady && pod.status.podIP) {
          this.logger.log(`Workspace pod ${podName} is ready (IP: ${pod.status.podIP})`);
          return { ready: true, podIP: pod.status.podIP };
        }
      }

      // Check for terminal states
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        return { ready: false, error: `pod_${pod.status.phase.toLowerCase()}` };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    return { ready: false, error: 'timeout' };
  }

  /**
   * v1.0.15: Create or ensure workspace (PVC + Pod) exists
   *
   * Idempotent method that creates PVC and pod if they don't exist,
   * and returns the current status if they do.
   *
   * @param workspaceId - Unique workspace identifier
   * @param tenantId - Tenant identifier
   * @param config - Persistence configuration
   * @param waitForReady - Whether to wait for pod to be ready
   */
  async ensureWorkspace(
    workspaceId: string,
    tenantId: string,
    config: PersistenceConfig,
    waitForReady: boolean = true,
    namespace?: string,
  ): Promise<WorkspaceCreateResult> {
    const ns = namespace || this.namespace;
    let pvcName: string | undefined;

    // Step 1: Create PVC only if persistence is enabled (backward compatibility)
    if (config.enabled !== false) {
      const pvcResult = await this.createWorkspacePVC(workspaceId, config, ns);
      if (!pvcResult.success) {
        return { success: false, error: `PVC creation failed: ${pvcResult.error}` };
      }
      pvcName = pvcResult.pvcName;
    } else {
      this.logger.debug(`Workspace ${workspaceId}: persistence disabled, skipping PVC creation`);
    }

    // Step 2: Create pod (with or without PVC mounts based on persistence config)
    const podResult = await this.createWorkspacePod(workspaceId, tenantId, config, undefined, ns);
    if (!podResult.success) {
      return { success: false, error: `Pod creation failed: ${podResult.error}`, pvcName };
    }

    // Step 3: Wait for pod to be ready if requested
    if (waitForReady) {
      const readyResult = await this.waitForWorkspacePodReady(workspaceId, 120000, 2000, ns);
      if (!readyResult.ready) {
        return {
          success: false,
          error: `Pod not ready: ${readyResult.error}`,
          pvcName,
          podName: podResult.podName,
        };
      }

      return {
        success: true,
        pvcName,
        podName: podResult.podName,
        podIP: readyResult.podIP,
        desktopEndpoint: readyResult.podIP ? `http://${readyResult.podIP}:9990` : undefined,
      };
    }

    return {
      success: true,
      pvcName,
      podName: podResult.podName,
      podIP: podResult.podIP,
      podUID: podResult.podUID,
    };
  }

  /**
   * v1.0.15: Terminate workspace (delete pod, optionally delete PVC)
   */
  async terminateWorkspace(
    workspaceId: string,
    deletePVC: boolean = false,
    namespace?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const ns = namespace || this.namespace;

    // Delete pod first
    const podResult = await this.deleteWorkspacePod(workspaceId, ns);
    if (!podResult.success) {
      return podResult;
    }

    // Delete PVC if requested
    if (deletePVC) {
      const pvcResult = await this.deleteWorkspacePVC(workspaceId, true, ns);
      if (!pvcResult.success) {
        return pvcResult;
      }
    }

    return { success: true };
  }

  /**
   * v1.0.15: Get TaskDesktop by workspaceId (searches by label)
   */
  async getTaskDesktopByWorkspaceId(
    workspaceId: string,
    namespace?: string,
  ): Promise<TaskDesktop | null> {
    const ns = namespace || this.namespace;

    try {
      const response = await this.customApi.listNamespacedCustomObject(
        'bytebot.ai',
        'v1alpha1',
        ns,
        'taskdesktops',
        undefined,
        undefined,
        undefined,
        undefined,
        `bytebot.ai/workspace-id=${workspaceId}`,
      );

      const list = response.body as unknown as TaskDesktopList;
      if (list.items.length === 0) {
        return null;
      }

      return list.items[0];
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}
