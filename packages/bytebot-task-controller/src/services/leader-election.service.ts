/**
 * Leader Election Service
 * Ensures only one controller instance is active at a time
 *
 * NOTE: Uses OnApplicationBootstrap instead of OnModuleInit to ensure
 * event handlers are registered before leadership events are emitted.
 * See: https://github.com/nestjs/event-emitter/issues/1063
 */

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KubernetesService } from './kubernetes.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as os from 'os';

export const LEADER_ELECTED_EVENT = 'leader.elected';
export const LEADER_LOST_EVENT = 'leader.lost';

@Injectable()
export class LeaderElectionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LeaderElectionService.name);
  private isLeader = false;
  private identity: string;
  private leaseName: string;
  private leaseDurationSeconds: number;
  private renewInterval: NodeJS.Timeout | null = null;
  private enabled: boolean;

  constructor(
    private k8sService: KubernetesService,
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
  ) {
    // Generate unique identity for this instance
    const podName = this.configService.get<string>('POD_NAME') || os.hostname();
    const podIP = this.configService.get<string>('POD_IP') || 'unknown';
    this.identity = `${podName}_${podIP}_${Date.now()}`;

    this.leaseName =
      this.configService.get<string>('LEADER_LEASE_NAME') ||
      'bytebot-task-controller-leader';
    this.leaseDurationSeconds = parseInt(
      this.configService.get<string>('LEADER_LEASE_DURATION') || '15',
      10,
    );
    this.enabled =
      this.configService.get<string>('LEADER_ELECTION_ENABLED') !== 'false';
  }

  async onApplicationBootstrap() {
    if (!this.enabled) {
      this.logger.warn('Leader election disabled, assuming leadership');
      this.isLeader = true;
      this.eventEmitter.emit(LEADER_ELECTED_EVENT);
      return;
    }

    this.logger.log(`Starting leader election with identity: ${this.identity}`);
    await this.tryAcquireLease();
    this.startRenewalLoop();
  }

  async onModuleDestroy() {
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
    }
  }

  /**
   * Check if this instance is the leader
   */
  isCurrentLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Get the current leader identity
   */
  getIdentity(): string {
    return this.identity;
  }

  /**
   * Try to acquire the leadership lease
   */
  private async tryAcquireLease(): Promise<void> {
    try {
      const acquired = await this.k8sService.acquireLease(
        this.leaseName,
        this.identity,
        this.leaseDurationSeconds,
      );

      if (acquired && !this.isLeader) {
        this.isLeader = true;
        this.logger.log(`Acquired leadership`);
        this.eventEmitter.emit(LEADER_ELECTED_EVENT);
      } else if (!acquired && this.isLeader) {
        this.isLeader = false;
        this.logger.warn(`Lost leadership`);
        this.eventEmitter.emit(LEADER_LOST_EVENT);
      }
    } catch (error) {
      this.logger.error(`Failed to acquire lease: ${error}`);
      if (this.isLeader) {
        this.isLeader = false;
        this.eventEmitter.emit(LEADER_LOST_EVENT);
      }
    }
  }

  /**
   * Renew the leadership lease
   */
  private async renewLease(): Promise<void> {
    if (!this.isLeader) {
      // Try to acquire if not leader
      await this.tryAcquireLease();
      return;
    }

    try {
      const renewed = await this.k8sService.renewLease(
        this.leaseName,
        this.identity,
      );

      if (!renewed) {
        this.logger.warn('Failed to renew lease, may have lost leadership');
        this.isLeader = false;
        this.eventEmitter.emit(LEADER_LOST_EVENT);
        // Try to reacquire
        await this.tryAcquireLease();
      }
    } catch (error) {
      this.logger.error(`Failed to renew lease: ${error}`);
    }
  }

  /**
   * Start the renewal loop
   */
  private startRenewalLoop(): void {
    // Renew at 2/3 of lease duration
    const renewPeriod = (this.leaseDurationSeconds * 1000 * 2) / 3;

    this.renewInterval = setInterval(async () => {
      await this.renewLease();
    }, renewPeriod);
  }
}
