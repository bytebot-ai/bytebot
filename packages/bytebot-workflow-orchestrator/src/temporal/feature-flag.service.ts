/**
 * Feature Flag Service for Temporal Migration
 *
 * Controls the gradual rollout of Temporal workflow execution.
 * Supports multiple strategies:
 * - Environment-based (all or nothing)
 * - Percentage-based (random sampling)
 * - Tenant-based (specific tenants)
 * - Goal-based (specific goal patterns)
 *
 * Industry patterns from LaunchDarkly, Unleash, and custom implementations.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FeatureFlagContext {
  tenantId: string;
  goalRunId: string;
  goalDescription?: string;
  userId?: string;
}

export interface FeatureFlagResult {
  enabled: boolean;
  reason: string;
  strategy: 'environment' | 'percentage' | 'tenant' | 'goal' | 'disabled';
}

@Injectable()
export class FeatureFlagService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagService.name);

  // Configuration
  private enabled = false;
  private rolloutPercentage = 0;
  private enabledTenants: Set<string> = new Set();
  private disabledTenants: Set<string> = new Set();
  private goalPatterns: RegExp[] = [];
  private killSwitch = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.loadConfiguration();
    this.logger.log(`Feature flag initialized: enabled=${this.enabled}, rollout=${this.rolloutPercentage}%`);
  }

  /**
   * Load feature flag configuration from environment
   */
  private loadConfiguration(): void {
    // Master switch
    this.enabled = this.configService.get<string>('TEMPORAL_WORKFLOW_ENABLED', 'false') === 'true';

    // Kill switch for instant rollback
    this.killSwitch = this.configService.get<string>('TEMPORAL_KILL_SWITCH', 'false') === 'true';

    // Percentage rollout (0-100)
    this.rolloutPercentage = parseInt(
      this.configService.get<string>('TEMPORAL_ROLLOUT_PERCENTAGE', '0'),
      10
    );

    // Tenant-based flags
    const enabledTenantsStr = this.configService.get<string>('TEMPORAL_ENABLED_TENANTS', '');
    if (enabledTenantsStr) {
      this.enabledTenants = new Set(enabledTenantsStr.split(',').map(t => t.trim()));
    }

    const disabledTenantsStr = this.configService.get<string>('TEMPORAL_DISABLED_TENANTS', '');
    if (disabledTenantsStr) {
      this.disabledTenants = new Set(disabledTenantsStr.split(',').map(t => t.trim()));
    }

    // Goal pattern matching (for testing specific goal types)
    const goalPatternsStr = this.configService.get<string>('TEMPORAL_GOAL_PATTERNS', '');
    if (goalPatternsStr) {
      this.goalPatterns = goalPatternsStr.split(',').map(p => new RegExp(p.trim(), 'i'));
    }
  }

  /**
   * Check if Temporal workflow should be used for this context
   */
  shouldUseTemporalWorkflow(context: FeatureFlagContext): FeatureFlagResult {
    // Kill switch overrides everything
    if (this.killSwitch) {
      return {
        enabled: false,
        reason: 'Kill switch activated',
        strategy: 'disabled',
      };
    }

    // Master switch must be on
    if (!this.enabled) {
      return {
        enabled: false,
        reason: 'Temporal workflows disabled globally',
        strategy: 'disabled',
      };
    }

    // Check if tenant is explicitly disabled
    if (this.disabledTenants.has(context.tenantId)) {
      return {
        enabled: false,
        reason: `Tenant ${context.tenantId} explicitly disabled`,
        strategy: 'tenant',
      };
    }

    // Check if tenant is explicitly enabled
    if (this.enabledTenants.has(context.tenantId)) {
      return {
        enabled: true,
        reason: `Tenant ${context.tenantId} explicitly enabled`,
        strategy: 'tenant',
      };
    }

    // Check goal patterns
    if (context.goalDescription && this.goalPatterns.length > 0) {
      for (const pattern of this.goalPatterns) {
        if (pattern.test(context.goalDescription)) {
          return {
            enabled: true,
            reason: `Goal matches pattern: ${pattern.source}`,
            strategy: 'goal',
          };
        }
      }
    }

    // Percentage-based rollout
    if (this.rolloutPercentage > 0) {
      // Use consistent hashing based on goalRunId for deterministic behavior
      const hash = this.hashString(context.goalRunId);
      const bucket = hash % 100;

      if (bucket < this.rolloutPercentage) {
        return {
          enabled: true,
          reason: `Percentage rollout: ${bucket} < ${this.rolloutPercentage}%`,
          strategy: 'percentage',
        };
      }
    }

    // Default to disabled
    return {
      enabled: false,
      reason: 'No matching rollout criteria',
      strategy: 'disabled',
    };
  }

  /**
   * Simple string hash for percentage-based rollout
   * Uses consistent hashing so same goalRunId always gets same bucket
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Get current rollout configuration (for debugging/monitoring)
   */
  getConfiguration(): {
    enabled: boolean;
    killSwitch: boolean;
    rolloutPercentage: number;
    enabledTenants: string[];
    disabledTenants: string[];
    goalPatterns: string[];
  } {
    return {
      enabled: this.enabled,
      killSwitch: this.killSwitch,
      rolloutPercentage: this.rolloutPercentage,
      enabledTenants: Array.from(this.enabledTenants),
      disabledTenants: Array.from(this.disabledTenants),
      goalPatterns: this.goalPatterns.map(p => p.source),
    };
  }

  /**
   * Update configuration at runtime (for testing/emergency changes)
   */
  updateConfiguration(updates: {
    enabled?: boolean;
    killSwitch?: boolean;
    rolloutPercentage?: number;
    enabledTenants?: string[];
    disabledTenants?: string[];
  }): void {
    if (updates.enabled !== undefined) {
      this.enabled = updates.enabled;
    }
    if (updates.killSwitch !== undefined) {
      this.killSwitch = updates.killSwitch;
    }
    if (updates.rolloutPercentage !== undefined) {
      this.rolloutPercentage = Math.max(0, Math.min(100, updates.rolloutPercentage));
    }
    if (updates.enabledTenants !== undefined) {
      this.enabledTenants = new Set(updates.enabledTenants);
    }
    if (updates.disabledTenants !== undefined) {
      this.disabledTenants = new Set(updates.disabledTenants);
    }

    this.logger.log(`Feature flag configuration updated: ${JSON.stringify(this.getConfiguration())}`);
  }

  /**
   * Activate kill switch (instant rollback)
   */
  activateKillSwitch(): void {
    this.killSwitch = true;
    this.logger.warn('KILL SWITCH ACTIVATED - All new goals will use legacy orchestrator');
  }

  /**
   * Deactivate kill switch
   */
  deactivateKillSwitch(): void {
    this.killSwitch = false;
    this.logger.log('Kill switch deactivated - Normal rollout rules apply');
  }
}
