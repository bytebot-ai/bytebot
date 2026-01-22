/**
 * Workspace Service
 * v2.3.0 M4: Workspace-aware desktop resolution and granular locking
 *
 * This service handles:
 * 1. Desktop endpoint resolution for persistent workspaces (Product 2: Workflows)
 * 2. Granular lock acquisition/release during desktop tool execution
 * 3. Integration with the workflow orchestrator for workspace status
 *
 * For Product 1 (Tasks), workspaceId is null and the existing TaskControllerService is used.
 * For Product 2 (Workflows), this service manages workspace-specific endpoints and locking.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Workspace status from orchestrator
 */
export interface WorkspaceInfo {
  id: string;
  tenantId: string;
  status: 'CREATING' | 'READY' | 'HIBERNATED' | 'TERMINATED' | 'FAILED';
  desktopEndpoint: string | null;
  vncEndpoint: string | null;
  lockOwnerNodeRunId: string | null;
  lockExpiresAt: string | null;
  lastHeartbeatAt: string | null;
}

/**
 * Lock acquisition result
 */
export interface LockAcquisitionResult {
  acquired: boolean;
  message: string;
  lockExpiresAt?: string;
  retryAfterMs?: number;
}

/**
 * Lock renewal result
 */
export interface LockRenewalResult {
  renewed: boolean;
  message: string;
  lockExpiresAt?: string;
}

/**
 * Default lock lease duration in seconds (30 seconds for desktop tool batches)
 */
const DEFAULT_LOCK_LEASE_SECONDS = 30;

/**
 * Lock renewal threshold - renew when less than this many seconds remaining
 */
const LOCK_RENEWAL_THRESHOLD_SECONDS = 10;

@Injectable()
export class WorkspaceService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly orchestratorUrl: string;
  private readonly internalToken: string;
  private readonly lockLeaseSeconds: number;

  // Cache workspace info to avoid repeated API calls
  private readonly workspaceCache: Map<string, { info: WorkspaceInfo; expiresAt: number }> = new Map();
  private readonly cacheTtlMs: number = 10000; // 10 second cache

  // Track active locks for automatic renewal
  private readonly activeLocks: Map<string, {
    workspaceId: string;
    nodeRunId: string;
    expiresAt: Date;
    renewalTimer: NodeJS.Timeout;
  }> = new Map();

  constructor(private readonly configService: ConfigService) {
    // Workflow orchestrator URL for workspace operations
    this.orchestratorUrl = this.configService.get<string>(
      'WORKFLOW_ORCHESTRATOR_URL',
      '',
    );

    // Internal service token for authenticated requests
    this.internalToken = this.configService.get<string>(
      'INTERNAL_SERVICE_TOKEN',
      '',
    );

    // Lock lease duration (configurable)
    this.lockLeaseSeconds = parseInt(
      this.configService.get<string>('WORKSPACE_LOCK_LEASE_SECONDS', String(DEFAULT_LOCK_LEASE_SECONDS)),
      10,
    );

    if (!this.orchestratorUrl) {
      this.logger.warn(
        'WORKFLOW_ORCHESTRATOR_URL not set - workspace features disabled (Product 1 only)',
      );
    } else {
      this.logger.log(`Workflow Orchestrator URL: ${this.orchestratorUrl}`);
      this.logger.log(`Workspace lock lease: ${this.lockLeaseSeconds} seconds`);
    }
  }

  onModuleDestroy() {
    // Clear all renewal timers and release locks
    for (const [key, lock] of this.activeLocks) {
      clearTimeout(lock.renewalTimer);
      // Best-effort release on shutdown
      this.releaseLock(lock.workspaceId, lock.nodeRunId).catch((err) => {
        this.logger.warn(`Failed to release lock on shutdown: ${err.message}`);
      });
    }
    this.activeLocks.clear();
    this.workspaceCache.clear();
  }

  /**
   * Check if workspace features are enabled (orchestrator configured)
   */
  isWorkspaceEnabled(): boolean {
    return !!this.orchestratorUrl;
  }

  /**
   * Get workspace info from orchestrator
   */
  async getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null> {
    if (!this.isWorkspaceEnabled()) {
      return null;
    }

    // Check cache first
    const cached = this.workspaceCache.get(workspaceId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.info;
    }

    try {
      const url = `${this.orchestratorUrl}/api/v1/workspaces/${workspaceId}`;
      this.logger.debug(`Fetching workspace info from ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn(`Workspace ${workspaceId} not found`);
          return null;
        }
        throw new Error(`Orchestrator returned ${response.status}`);
      }

      const workspaceInfo: WorkspaceInfo = await response.json();

      // Cache the result
      this.workspaceCache.set(workspaceId, {
        info: workspaceInfo,
        expiresAt: Date.now() + this.cacheTtlMs,
      });

      this.logger.debug(
        `Workspace ${workspaceId}: status=${workspaceInfo.status}, desktop=${workspaceInfo.desktopEndpoint}`,
      );

      return workspaceInfo;
    } catch (error: any) {
      this.logger.error(`Failed to fetch workspace ${workspaceId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get desktop URL for a workspace
   * Returns null if workspace not ready or doesn't exist
   */
  async getDesktopUrl(workspaceId: string): Promise<string | null> {
    const info = await this.getWorkspaceInfo(workspaceId);

    if (!info) {
      return null;
    }

    if (info.status !== 'READY') {
      this.logger.warn(`Workspace ${workspaceId} not ready: status=${info.status}`);
      return null;
    }

    return info.desktopEndpoint;
  }

  /**
   * Wake a hibernated workspace
   */
  async wakeWorkspace(workspaceId: string): Promise<boolean> {
    if (!this.isWorkspaceEnabled()) {
      return false;
    }

    try {
      const url = `${this.orchestratorUrl}/api/v1/workspaces/${workspaceId}/wake`;
      this.logger.log(`Waking workspace ${workspaceId}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
      });

      if (!response.ok) {
        throw new Error(`Wake request failed with status ${response.status}`);
      }

      // Invalidate cache
      this.workspaceCache.delete(workspaceId);

      this.logger.log(`Workspace ${workspaceId} wake initiated`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to wake workspace ${workspaceId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Wait for workspace to be ready
   * Handles HIBERNATED -> READY transition
   */
  async waitForWorkspaceReady(
    workspaceId: string,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
    } = {},
  ): Promise<string> {
    const {
      timeoutMs = 120000, // 2 minute timeout (includes wake time)
      pollIntervalMs = 2000, // Poll every 2 seconds
    } = options;

    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // Invalidate cache to get fresh status
      this.workspaceCache.delete(workspaceId);

      const info = await this.getWorkspaceInfo(workspaceId);

      if (!info) {
        throw new Error(`Workspace ${workspaceId} not found`);
      }

      switch (info.status) {
        case 'READY':
          if (info.desktopEndpoint) {
            this.logger.log(`Workspace ${workspaceId} ready: ${info.desktopEndpoint}`);
            return info.desktopEndpoint;
          }
          throw new Error(`Workspace ${workspaceId} ready but no desktop endpoint`);

        case 'HIBERNATED':
          this.logger.log(`Workspace ${workspaceId} hibernated, waking...`);
          await this.wakeWorkspace(workspaceId);
          break;

        case 'CREATING':
          this.logger.debug(`Workspace ${workspaceId} still creating...`);
          break;

        case 'TERMINATED':
        case 'FAILED':
          throw new Error(`Workspace ${workspaceId} in terminal state: ${info.status}`);

        default:
          this.logger.warn(`Workspace ${workspaceId} in unknown state: ${info.status}`);
      }

      // Wait before next poll
      await this.sleep(pollIntervalMs);
    }

    throw new Error(`Timeout waiting for workspace ${workspaceId} to be ready`);
  }

  /**
   * Acquire a granular lock on the workspace for desktop tool execution
   *
   * The lock is held only during active desktop tool execution (30-60 seconds),
   * NOT for the entire node run. This allows concurrent non-desktop work.
   */
  async acquireLock(
    workspaceId: string,
    nodeRunId: string,
    leaseSeconds?: number,
  ): Promise<LockAcquisitionResult> {
    if (!this.isWorkspaceEnabled()) {
      // In non-workspace mode, always succeed (no locking needed)
      return { acquired: true, message: 'Workspace features disabled' };
    }

    const lease = leaseSeconds || this.lockLeaseSeconds;

    try {
      const url = `${this.orchestratorUrl}/api/v1/workspaces/${workspaceId}/lock`;
      this.logger.log(`Acquiring lock on workspace ${workspaceId} for nodeRun ${nodeRunId} (${lease}s lease)`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
        body: JSON.stringify({
          nodeRunId,
          leaseSeconds: lease,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        // Lock contention - another node run holds the lock
        if (response.status === 409) {
          this.logger.warn(`Lock contention on workspace ${workspaceId}: ${result.message}`);
          return {
            acquired: false,
            message: result.message || 'Lock held by another node run',
            retryAfterMs: result.retryAfterMs || 5000,
          };
        }
        throw new Error(`Lock acquisition failed: ${response.status}`);
      }

      this.logger.log(`Lock acquired on workspace ${workspaceId} for nodeRun ${nodeRunId}`);

      // Set up automatic renewal
      const lockKey = `${workspaceId}:${nodeRunId}`;
      const expiresAt = new Date(result.lockExpiresAt);

      // Schedule renewal before expiry
      const renewalMs = Math.max((lease - LOCK_RENEWAL_THRESHOLD_SECONDS) * 1000, 5000);
      const renewalTimer = setTimeout(() => {
        this.renewLockInternal(workspaceId, nodeRunId).catch((err) => {
          this.logger.error(`Lock renewal failed: ${err.message}`);
        });
      }, renewalMs);

      this.activeLocks.set(lockKey, {
        workspaceId,
        nodeRunId,
        expiresAt,
        renewalTimer,
      });

      return {
        acquired: true,
        message: 'Lock acquired',
        lockExpiresAt: result.lockExpiresAt,
      };
    } catch (error: any) {
      this.logger.error(`Failed to acquire lock on workspace ${workspaceId}: ${error.message}`);
      return {
        acquired: false,
        message: `Lock acquisition error: ${error.message}`,
      };
    }
  }

  /**
   * Internal lock renewal (called by timer)
   */
  private async renewLockInternal(workspaceId: string, nodeRunId: string): Promise<void> {
    const lockKey = `${workspaceId}:${nodeRunId}`;
    const activeLock = this.activeLocks.get(lockKey);

    if (!activeLock) {
      this.logger.debug(`Lock ${lockKey} no longer active, skipping renewal`);
      return;
    }

    const result = await this.renewLock(workspaceId, nodeRunId);

    if (result.renewed) {
      // Schedule next renewal
      const renewalMs = Math.max((this.lockLeaseSeconds - LOCK_RENEWAL_THRESHOLD_SECONDS) * 1000, 5000);
      activeLock.expiresAt = new Date(result.lockExpiresAt!);
      activeLock.renewalTimer = setTimeout(() => {
        this.renewLockInternal(workspaceId, nodeRunId).catch((err) => {
          this.logger.error(`Lock renewal failed: ${err.message}`);
        });
      }, renewalMs);
    } else {
      // Lock lost, clean up
      this.activeLocks.delete(lockKey);
      this.logger.warn(`Lock renewal failed for ${lockKey}, lock lost`);
    }
  }

  /**
   * Renew an existing lock
   */
  async renewLock(workspaceId: string, nodeRunId: string): Promise<LockRenewalResult> {
    if (!this.isWorkspaceEnabled()) {
      return { renewed: true, message: 'Workspace features disabled' };
    }

    try {
      const url = `${this.orchestratorUrl}/api/v1/workspaces/${workspaceId}/lock/renew`;
      this.logger.debug(`Renewing lock on workspace ${workspaceId} for nodeRun ${nodeRunId}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
        body: JSON.stringify({
          nodeRunId,
          leaseSeconds: this.lockLeaseSeconds,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        return {
          renewed: false,
          message: error.message || `Renewal failed with status ${response.status}`,
        };
      }

      const result = await response.json();
      this.logger.debug(`Lock renewed on workspace ${workspaceId}, expires ${result.lockExpiresAt}`);

      return {
        renewed: true,
        message: 'Lock renewed',
        lockExpiresAt: result.lockExpiresAt,
      };
    } catch (error: any) {
      this.logger.error(`Failed to renew lock on workspace ${workspaceId}: ${error.message}`);
      return {
        renewed: false,
        message: `Renewal error: ${error.message}`,
      };
    }
  }

  /**
   * Release a lock on the workspace
   */
  async releaseLock(workspaceId: string, nodeRunId: string): Promise<boolean> {
    const lockKey = `${workspaceId}:${nodeRunId}`;

    // Clear renewal timer
    const activeLock = this.activeLocks.get(lockKey);
    if (activeLock) {
      clearTimeout(activeLock.renewalTimer);
      this.activeLocks.delete(lockKey);
    }

    if (!this.isWorkspaceEnabled()) {
      return true;
    }

    try {
      const url = `${this.orchestratorUrl}/api/v1/workspaces/${workspaceId}/lock`;
      this.logger.log(`Releasing lock on workspace ${workspaceId} for nodeRun ${nodeRunId}`);

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
        body: JSON.stringify({ nodeRunId }),
      });

      if (!response.ok && response.status !== 404) {
        throw new Error(`Lock release failed: ${response.status}`);
      }

      this.logger.log(`Lock released on workspace ${workspaceId}`);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to release lock on workspace ${workspaceId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if this nodeRun currently holds the lock
   */
  hasActiveLock(workspaceId: string, nodeRunId: string): boolean {
    const lockKey = `${workspaceId}:${nodeRunId}`;
    const lock = this.activeLocks.get(lockKey);

    if (!lock) {
      return false;
    }

    // Check if lock has expired
    if (lock.expiresAt < new Date()) {
      this.activeLocks.delete(lockKey);
      return false;
    }

    return true;
  }

  /**
   * Invalidate cached workspace info
   */
  invalidateCache(workspaceId: string): void {
    this.workspaceCache.delete(workspaceId);
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
