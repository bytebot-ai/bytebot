/**
 * Leader Election Service
 * v1.0.3: Kubernetes Lease-based leader election for scheduler single-runner guarantee
 *
 * Uses the coordination.k8s.io/v1 Lease API to ensure only one replica
 * runs the scheduler at a time.
 *
 * Configuration (environment variables):
 * - LEADER_ELECTION_ENABLED: Enable/disable leader election (default: true in K8s, false locally)
 * - LEADER_ELECTION_LEASE_NAME: Name of the lease object (default: workflow-orchestrator-scheduler)
 * - LEADER_ELECTION_NAMESPACE: Kubernetes namespace (default: from cluster or 'default')
 * - LEADER_ELECTION_LEASE_DURATION: Lease duration in seconds (default: 15)
 * - LEADER_ELECTION_RENEW_DEADLINE: Renew deadline in seconds (default: 10)
 * - LEADER_ELECTION_RETRY_PERIOD: Retry period in seconds (default: 2)
 * - POD_NAME: Pod identity (injected from Kubernetes downward API)
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as k8s from '@kubernetes/client-node';
import * as os from 'os';

export const LEADER_ELECTED_EVENT = 'leader.elected';
export const LEADER_LOST_EVENT = 'leader.lost';

export interface LeaderElectionConfig {
  enabled: boolean;
  leaseName: string;
  leaseNamespace: string;
  leaseDurationSeconds: number;
  renewDeadlineSeconds: number;
  retryPeriodSeconds: number;
}

/**
 * Format a Date as RFC 3339 with microsecond precision for Kubernetes MicroTime fields.
 * Kubernetes expects format: 2006-01-02T15:04:05.000000Z
 */
function formatMicroTime(date: Date): string {
  const iso = date.toISOString(); // e.g., "2025-12-13T19:04:41.512Z"
  // Replace milliseconds with microseconds (pad to 6 digits)
  return iso.replace(/\.\d{3}Z$/, '.' + date.getMilliseconds().toString().padStart(3, '0') + '000Z');
}

@Injectable()
export class LeaderElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);
  private kc: k8s.KubeConfig | null = null;
  private coordinationApi: k8s.CoordinationV1Api | null = null;

  private _isLeader = false;
  private leaderCheckInterval: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  private readonly config: LeaderElectionConfig;
  private readonly identity: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // Determine if we're running in Kubernetes
    const inKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;

    // Configuration with sensible defaults
    this.config = {
      enabled:
        this.configService.get<string>('LEADER_ELECTION_ENABLED', inKubernetes ? 'true' : 'false') ===
        'true',
      leaseName: this.configService.get<string>(
        'LEADER_ELECTION_LEASE_NAME',
        'workflow-orchestrator-scheduler',
      ),
      leaseNamespace: this.configService.get<string>(
        'LEADER_ELECTION_NAMESPACE',
        process.env.POD_NAMESPACE || 'bytebot',
      ),
      leaseDurationSeconds: parseInt(
        this.configService.get<string>('LEADER_ELECTION_LEASE_DURATION', '15'),
        10,
      ),
      renewDeadlineSeconds: parseInt(
        this.configService.get<string>('LEADER_ELECTION_RENEW_DEADLINE', '10'),
        10,
      ),
      retryPeriodSeconds: parseInt(
        this.configService.get<string>('LEADER_ELECTION_RETRY_PERIOD', '2'),
        10,
      ),
    };

    // Unique identity for this pod
    this.identity =
      process.env.POD_NAME || `${os.hostname()}-${process.pid}-${Date.now()}`;

    if (this.config.enabled) {
      try {
        this.kc = new k8s.KubeConfig();

        if (inKubernetes) {
          this.kc.loadFromCluster();
          this.logger.log('Loaded Kubernetes config from cluster');
        } else {
          this.kc.loadFromDefault();
          this.logger.log('Loaded Kubernetes config from default location');
        }

        this.coordinationApi = this.kc.makeApiClient(k8s.CoordinationV1Api);
      } catch (error: any) {
        this.logger.error(`Failed to initialize Kubernetes client: ${error.message}`);
        // Disable leader election if we can't connect
        this.config.enabled = false;
      }
    }

    this.logger.log(
      `Leader election ${this.config.enabled ? 'ENABLED' : 'DISABLED'} with identity: ${this.identity}`,
    );
  }

  get isLeader(): boolean {
    // If leader election is disabled, always return true (single instance mode)
    if (!this.config.enabled) {
      return true;
    }
    return this._isLeader;
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('Leader election disabled - this instance will act as leader');
      this._isLeader = true;
      this.eventEmitter.emit(LEADER_ELECTED_EVENT, { identity: this.identity });
      return;
    }

    this.logger.log('Starting leader election...');
    // Start leader election in background (non-blocking)
    // This allows the application to start while leader election runs
    this.startLeaderElection().catch((error) => {
      this.logger.error(`Failed to start leader election: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down leader election...');
    this.shuttingDown = true;

    if (this.leaderCheckInterval) {
      clearInterval(this.leaderCheckInterval);
      this.leaderCheckInterval = null;
    }

    // Release leadership gracefully
    if (this._isLeader && this.config.enabled) {
      await this.releaseLease();
    }
  }

  private async startLeaderElection(): Promise<void> {
    // Set up periodic lease operations FIRST so even if first attempt hangs, we still retry
    this.leaderCheckInterval = setInterval(
      () => this.tryAcquireOrRenewLease().catch((e) => {
        this.logger.error(`Leader election retry failed: ${e.message}`);
      }),
      this.config.retryPeriodSeconds * 1000,
    );
    this.logger.log('Leader election interval started');

    // Initial attempt to acquire or check lease (non-blocking)
    try {
      await this.tryAcquireOrRenewLease();
    } catch (error: any) {
      this.logger.error(`Initial leader election attempt failed: ${error.message}`);
    }
  }

  private async tryAcquireOrRenewLease(): Promise<void> {
    if (this.shuttingDown || !this.coordinationApi) return;

    try {
      const lease = await this.getOrCreateLease();

      if (this.isLeaseHeldByUs(lease)) {
        // We hold the lease, renew it
        await this.renewLease(lease);
      } else if (this.isLeaseExpired(lease)) {
        // Lease is expired, try to acquire it
        await this.acquireLease(lease);
      } else {
        // Someone else holds a valid lease
        if (this._isLeader) {
          this.loseLeadership();
        }
      }
    } catch (error: any) {
      this.logger.error(`Leader election error: ${error.message}`);
      if (this._isLeader) {
        this.loseLeadership();
      }
    }
  }

  private async getOrCreateLease(): Promise<k8s.V1Lease> {
    if (!this.coordinationApi) {
      throw new Error('Kubernetes API not initialized');
    }

    try {
      const { body } = await this.coordinationApi.readNamespacedLease(
        this.config.leaseName,
        this.config.leaseNamespace,
      );
      return body;
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Lease doesn't exist, create it
        return this.createLease();
      }
      throw error;
    }
  }

  private async createLease(): Promise<k8s.V1Lease> {
    if (!this.coordinationApi) {
      throw new Error('Kubernetes API not initialized');
    }

    const now = new Date();
    const microTimeNow = formatMicroTime(now);
    const lease: k8s.V1Lease = {
      apiVersion: 'coordination.k8s.io/v1',
      kind: 'Lease',
      metadata: {
        name: this.config.leaseName,
        namespace: this.config.leaseNamespace,
        labels: {
          'app.kubernetes.io/name': 'workflow-orchestrator',
          'app.kubernetes.io/component': 'scheduler',
        },
      },
      spec: {
        holderIdentity: this.identity,
        leaseDurationSeconds: this.config.leaseDurationSeconds,
        acquireTime: microTimeNow as unknown as Date,
        renewTime: microTimeNow as unknown as Date,
        leaseTransitions: 0,
      },
    };

    const { body } = await this.coordinationApi.createNamespacedLease(
      this.config.leaseNamespace,
      lease,
    );

    this.becomeLeader();
    this.logger.log('Created new lease and became leader');
    return body;
  }

  private async acquireLease(existingLease: k8s.V1Lease): Promise<void> {
    if (!this.coordinationApi) return;

    const now = new Date();
    const microTimeNow = formatMicroTime(now);
    const updatedLease: k8s.V1Lease = {
      ...existingLease,
      spec: {
        ...existingLease.spec,
        holderIdentity: this.identity,
        acquireTime: microTimeNow as unknown as Date,
        renewTime: microTimeNow as unknown as Date,
        leaseTransitions: (existingLease.spec?.leaseTransitions || 0) + 1,
      },
    };

    try {
      await this.coordinationApi.replaceNamespacedLease(
        this.config.leaseName,
        this.config.leaseNamespace,
        updatedLease,
      );
      this.becomeLeader();
      this.logger.log('Acquired lease and became leader');
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Conflict - someone else got the lease first
        this.logger.debug('Failed to acquire lease - conflict');
      } else {
        throw error;
      }
    }
  }

  private async renewLease(existingLease: k8s.V1Lease): Promise<void> {
    if (!this.coordinationApi) return;

    const now = new Date();
    const microTimeNow = formatMicroTime(now);
    const updatedLease: k8s.V1Lease = {
      ...existingLease,
      spec: {
        ...existingLease.spec,
        renewTime: microTimeNow as unknown as Date,
      },
    };

    try {
      await this.coordinationApi.replaceNamespacedLease(
        this.config.leaseName,
        this.config.leaseNamespace,
        updatedLease,
      );

      if (!this._isLeader) {
        this.becomeLeader();
      }
    } catch (error: any) {
      if (error.statusCode === 409) {
        this.logger.warn('Lost lease during renewal - conflict');
        this.loseLeadership();
      } else {
        throw error;
      }
    }
  }

  private async releaseLease(): Promise<void> {
    if (!this.coordinationApi) return;

    try {
      const { body: lease } = await this.coordinationApi.readNamespacedLease(
        this.config.leaseName,
        this.config.leaseNamespace,
      );

      if (this.isLeaseHeldByUs(lease)) {
        // Set holder to empty to release immediately
        const microTimeNow = formatMicroTime(new Date());
        const updatedLease: k8s.V1Lease = {
          ...lease,
          spec: {
            ...lease.spec,
            holderIdentity: '',
            renewTime: microTimeNow as unknown as Date,
          },
        };

        await this.coordinationApi.replaceNamespacedLease(
          this.config.leaseName,
          this.config.leaseNamespace,
          updatedLease,
        );
        this.logger.log('Released lease successfully');
      }
    } catch (error: any) {
      this.logger.error(`Failed to release lease: ${error.message}`);
    }
  }

  private isLeaseHeldByUs(lease: k8s.V1Lease): boolean {
    return lease.spec?.holderIdentity === this.identity;
  }

  private isLeaseExpired(lease: k8s.V1Lease): boolean {
    if (!lease.spec?.renewTime || !lease.spec?.leaseDurationSeconds) {
      return true;
    }

    const renewTime = new Date(lease.spec.renewTime as unknown as string).getTime();
    const expirationTime = renewTime + lease.spec.leaseDurationSeconds * 1000;
    return Date.now() > expirationTime;
  }

  private becomeLeader(): void {
    if (!this._isLeader) {
      this._isLeader = true;
      this.logger.log('🏆 This instance is now the LEADER');
      this.eventEmitter.emit(LEADER_ELECTED_EVENT, { identity: this.identity });
    }
  }

  private loseLeadership(): void {
    if (this._isLeader) {
      this._isLeader = false;
      this.logger.warn('⚠️ This instance LOST leadership');
      this.eventEmitter.emit(LEADER_LOST_EVENT, { identity: this.identity });
    }
  }

  /**
   * Get leadership status for health checks and monitoring
   */
  getLeadershipStatus(): {
    enabled: boolean;
    isLeader: boolean;
    identity: string;
    leaseName: string;
    leaseNamespace: string;
  } {
    return {
      enabled: this.config.enabled,
      isLeader: this.isLeader,
      identity: this.identity,
      leaseName: this.config.leaseName,
      leaseNamespace: this.config.leaseNamespace,
    };
  }
}
