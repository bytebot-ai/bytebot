/**
 * Task Controller Client Service
 * Phase 6.4: Agent Integration
 *
 * Fetches per-task credentials and desktop URLs from the Task Controller.
 * Replaces global BYTEBOT_DESKTOP_BASE_URL with dynamic per-task URLs.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Task info returned from the task controller
 */
export interface TaskInfo {
  taskId: string;
  tenantId: string;
  phase: string;
  desktopEndpoint: string | null;
  vncEndpoint: string | null;
  routerUrl: string;
  credentials: {
    apiToken: string;
    vncPassword: string;
    expiresAt: string;
  } | null;
  timeoutAt: string | null;
  startedAt: string | null;
}

export type DesktopTakeoverNotAvailableReason =
  | 'LEASE_EXPIRED'
  | 'DESKTOP_TIMED_OUT';

export type DesktopTakeoverAvailability =
  | { ok: true; desktopUrl: string; timeoutAt: string | null }
  | {
      ok: false;
      reason: DesktopTakeoverNotAvailableReason;
      details?: Record<string, unknown>;
    };

/**
 * Heartbeat response from the task controller
 *
 * v2.2.1: Added `ready`, `phase`, and `message` fields to support proper
 * wait-for-desktop mechanism. The agent should wait until `ready=true`
 * before attempting to execute actions.
 *
 * - `shouldContinue`: true if agent should stay alive (false for terminal phases)
 * - `ready`: true only when desktop is ready for execution (phase=Running)
 * - `phase`: current TaskDesktop phase for debugging
 * - `message`: human-readable status message
 *
 * v2.2.11: Added `estimatedWaitTime` for WaitingForCapacity phase to dynamically
 * extend agent timeout when waiting for overflow pool capacity.
 */
export interface HeartbeatResponse {
  acknowledged: boolean;
  shouldContinue: boolean;
  ready: boolean; // v2.2.1: true only when desktop is ready for execution
  phase: string; // v2.2.1: current phase for debugging
  message: string; // v2.2.1: human-readable status message
  timeRemaining: number; // seconds
  warningThreshold: boolean; // true if <5 min remaining
  estimatedWaitTime?: number; // v2.2.11: seconds remaining in capacity wait (only for WaitingForCapacity)
}

/**
 * Cached task info with expiry
 */
interface CachedTaskInfo {
  info: TaskInfo;
  fetchedAt: number;
  expiresAt: number;
}

@Injectable()
export class TaskControllerService implements OnModuleDestroy {
  private readonly logger = new Logger(TaskControllerService.name);
  private readonly controllerUrl: string;
  private readonly fallbackDesktopUrl: string;
  private readonly cacheTtlMs: number = 30000; // 30 seconds cache
  private readonly heartbeatIntervalMs: number;
  private readonly taskCache: Map<string, CachedTaskInfo> = new Map();
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  // v2.2.22: 404 grace window for transient task creation delays
  private readonly notFound404GraceMs: number = 30000; // 30 seconds grace for initial 404s
  private readonly task404GraceStart: Map<string, number> = new Map(); // Track when 404 grace started per task

  constructor(private readonly configService: ConfigService) {
    // Task controller URL - falls back to empty if not configured (Phase 6 not deployed)
    this.controllerUrl = this.configService.get<string>(
      'TASK_CONTROLLER_URL',
      '',
    );

    // Fallback to legacy desktop URL if task controller not available
    this.fallbackDesktopUrl = this.configService.get<string>(
      'BYTEBOT_DESKTOP_BASE_URL',
      'http://bytebot-desktop:9990',
    );

    // Heartbeat interval (default 15 seconds)
    this.heartbeatIntervalMs = parseInt(
      this.configService.get<string>('HEARTBEAT_INTERVAL_MS', '15000'),
      10,
    );

    if (!this.controllerUrl) {
      this.logger.warn(
        'TASK_CONTROLLER_URL not set - using fallback desktop URL for all tasks (Phase 6 compatibility mode)',
      );
    } else {
      this.logger.log(`Task Controller URL: ${this.controllerUrl}`);
    }
  }

  onModuleDestroy() {
    // Clear all heartbeat intervals
    for (const [taskId, interval] of this.heartbeatIntervals) {
      clearInterval(interval);
      this.logger.debug(`Cleared heartbeat interval for task ${taskId}`);
    }
    this.heartbeatIntervals.clear();
    this.taskCache.clear();
    this.task404GraceStart.clear(); // v2.2.22
  }

  /**
   * Check if Phase 6 task controller is available
   */
  isPhase6Enabled(): boolean {
    return !!this.controllerUrl;
  }

  /**
   * Get task info including desktop URL and credentials
   * Uses caching to reduce API calls
   */
  async getTaskInfo(taskId: string): Promise<TaskInfo | null> {
    // Check cache first
    const cached = this.taskCache.get(taskId);
    if (cached && Date.now() < cached.expiresAt) {
      this.logger.debug(`Using cached task info for ${taskId}`);
      return cached.info;
    }

    // If Phase 6 not enabled, return fallback info
    if (!this.isPhase6Enabled()) {
      return this.getFallbackTaskInfo(taskId);
    }

    try {
      const url = `${this.controllerUrl}/api/v1/tasks/${taskId}`;
      this.logger.debug(`Fetching task info from ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn(`Task ${taskId} not found in controller`);
          // Fall back to legacy mode
          return this.getFallbackTaskInfo(taskId);
        }
        throw new Error(`Task controller returned ${response.status}`);
      }

      const taskInfo: TaskInfo = await response.json();

      // Cache the result
      const expiresAt = Date.now() + this.cacheTtlMs;
      this.taskCache.set(taskId, {
        info: taskInfo,
        fetchedAt: Date.now(),
        expiresAt,
      });

      this.logger.log(
        `Fetched task info for ${taskId}: phase=${taskInfo.phase}, desktop=${taskInfo.desktopEndpoint}`,
      );

      return taskInfo;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch task info for ${taskId}: ${error.message}`,
      );
      // Fall back to legacy mode on error
      return this.getFallbackTaskInfo(taskId);
    }
  }

  /**
   * Strictly determines whether a desktop takeover is available.
   *
   * Important: When Phase 6 is enabled, we must not fall back to legacy mode
   * on 404 or controller errors, otherwise we can incorrectly offer takeover
   * for a desktop session that has already expired.
   *
   * This method is intentionally fail-closed: if we cannot verify the session,
   * we treat takeover as not available and avoid mutating task state.
   */
  async getDesktopTakeoverAvailability(
    taskId: string,
  ): Promise<DesktopTakeoverAvailability> {
    if (!this.isPhase6Enabled()) {
      return { ok: true, desktopUrl: this.fallbackDesktopUrl, timeoutAt: null };
    }

    try {
      const url = `${this.controllerUrl}/api/v1/tasks/${taskId}`;
      this.logger.debug(`Checking takeover availability via ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            ok: false,
            reason: 'LEASE_EXPIRED',
            details: { status: 404 },
          };
        }

        return {
          ok: false,
          reason: 'LEASE_EXPIRED',
          details: { status: response.status },
        };
      }

      const taskInfo: TaskInfo = await response.json();

      if (
        typeof taskInfo.timeoutAt === 'string' &&
        taskInfo.timeoutAt.trim().length > 0
      ) {
        const timeoutMs = Date.parse(taskInfo.timeoutAt);
        if (!Number.isFinite(timeoutMs)) {
          this.logger.warn(
            `Task ${taskId} returned an invalid timeoutAt; failing takeover closed: ${taskInfo.timeoutAt}`,
          );
          return {
            ok: false,
            reason: 'LEASE_EXPIRED',
            details: {
              timeoutAt: taskInfo.timeoutAt,
              phase: taskInfo.phase,
              invalid: true,
            },
          };
        }

        if (timeoutMs <= Date.now()) {
          return {
            ok: false,
            reason: 'DESKTOP_TIMED_OUT',
            details: { timeoutAt: taskInfo.timeoutAt, phase: taskInfo.phase },
          };
        }
      }

      if (!taskInfo.desktopEndpoint) {
        return {
          ok: false,
          reason: 'LEASE_EXPIRED',
          details: { phase: taskInfo.phase },
        };
      }

      return {
        ok: true,
        desktopUrl: taskInfo.desktopEndpoint,
        timeoutAt: taskInfo.timeoutAt ?? null,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to check takeover availability for ${taskId}: ${error.message}`,
      );
      return {
        ok: false,
        reason: 'LEASE_EXPIRED',
        details: { error: error.message },
      };
    }
  }

  /**
   * Get desktop URL for a task
   * Primary method for agent to get the correct desktop endpoint
   *
   * v2.2.1: This method now only returns the URL if the desktop is ready.
   * For waiting until ready, use `waitForDesktop()` instead.
   */
  async getDesktopUrl(taskId: string): Promise<string> {
    const taskInfo = await this.getTaskInfo(taskId);

    if (taskInfo?.desktopEndpoint) {
      return taskInfo.desktopEndpoint;
    }

    // v2.2.1: Only fall back to legacy URL if Phase 6 is not enabled
    // When Phase 6 is enabled, we should wait for the desktop to be ready
    if (!this.isPhase6Enabled()) {
      this.logger.debug(
        `No desktop endpoint for ${taskId}, using fallback: ${this.fallbackDesktopUrl}`,
      );
      return this.fallbackDesktopUrl;
    }

    // Phase 6 is enabled but no desktop endpoint yet - this shouldn't happen
    // after calling waitForDesktop(), but log a warning
    this.logger.warn(
      `Phase 6 enabled but no desktop endpoint for ${taskId} - task may not be ready`,
    );
    throw new Error(`Desktop not ready for task ${taskId}`);
  }

  /**
   * Wait for desktop to be ready for a task
   *
   * v2.2.1: New method that polls the heartbeat endpoint until the desktop
   * is ready (phase=Running). Uses exponential backoff with jitter.
   *
   * v2.2.11: Enhanced to dynamically extend timeout when in WaitingForCapacity
   * phase. This prevents premature timeouts when waiting for overflow pool
   * capacity to be provisioned (which can take 30-90 seconds).
   *
   * @param taskId - The task ID to wait for
   * @param options - Wait options
   * @returns The desktop URL once ready
   * @throws Error if task times out, is cancelled, or enters a terminal state
   */
  async waitForDesktop(
    taskId: string,
    options: {
      timeoutMs?: number;
      initialDelayMs?: number;
      maxDelayMs?: number;
      capacityWaitExtensionMs?: number; // v2.2.11: Additional time to wait during capacity wait
    } = {},
  ): Promise<string> {
    const {
      timeoutMs = 60000, // 60 second default timeout
      initialDelayMs = 500, // Start with 500ms delay
      maxDelayMs = 5000, // Cap at 5 second delay
      capacityWaitExtensionMs = 180000, // v2.2.11: 3 minute extension for capacity wait
    } = options;

    // In legacy mode, desktop is always ready
    if (!this.isPhase6Enabled()) {
      this.logger.debug(
        `waitForDesktop: Legacy mode, returning fallback URL immediately`,
      );
      return this.fallbackDesktopUrl;
    }

    const startTime = Date.now();
    let currentDelay = initialDelayMs;
    let attempts = 0;
    // v2.2.11: Track effective timeout which can be extended during capacity wait
    let effectiveTimeoutMs = timeoutMs;
    let capacityWaitLogged = false;

    this.logger.log(
      `waitForDesktop: Waiting for desktop to be ready for task ${taskId} (initial timeout: ${timeoutMs}ms)`,
    );

    while (Date.now() - startTime < effectiveTimeoutMs) {
      attempts++;

      // Post heartbeat with 'waiting' status
      const heartbeat = await this.postHeartbeat(taskId, 'waiting_for_desktop');

      // Check if we should stop waiting
      if (!heartbeat.shouldContinue) {
        this.logger.error(
          `waitForDesktop: Task ${taskId} signaled to stop: phase=${heartbeat.phase}, message=${heartbeat.message}`,
        );
        throw new Error(
          `Task ${taskId} terminated while waiting for desktop: ${heartbeat.phase} - ${heartbeat.message}`,
        );
      }

      // v2.2.11: If in WaitingForCapacity phase, extend timeout to accommodate capacity provisioning
      if (heartbeat.phase === 'WaitingForCapacity') {
        // Calculate new effective timeout based on server-provided estimatedWaitTime or extension
        if (
          heartbeat.estimatedWaitTime !== undefined &&
          heartbeat.estimatedWaitTime > 0
        ) {
          // Server knows how long capacity wait will last
          const serverSuggestedTimeout =
            Date.now() - startTime + heartbeat.estimatedWaitTime * 1000 + 30000; // +30s buffer
          if (serverSuggestedTimeout > effectiveTimeoutMs) {
            effectiveTimeoutMs = serverSuggestedTimeout;
            if (!capacityWaitLogged) {
              this.logger.log(
                `waitForDesktop: Task ${taskId} in WaitingForCapacity phase, extended timeout to ${Math.round(effectiveTimeoutMs / 1000)}s ` +
                  `(server estimated wait: ${heartbeat.estimatedWaitTime}s)`,
              );
              capacityWaitLogged = true;
            }
          }
        } else {
          // Use default extension
          const extendedTimeout =
            Date.now() - startTime + capacityWaitExtensionMs;
          if (extendedTimeout > effectiveTimeoutMs) {
            effectiveTimeoutMs = extendedTimeout;
            if (!capacityWaitLogged) {
              this.logger.log(
                `waitForDesktop: Task ${taskId} in WaitingForCapacity phase, extended timeout to ${Math.round(effectiveTimeoutMs / 1000)}s`,
              );
              capacityWaitLogged = true;
            }
          }
        }
      }

      // Check if desktop is ready
      if (heartbeat.ready) {
        this.logger.log(
          `waitForDesktop: Desktop ready for task ${taskId} after ${attempts} attempts (${Date.now() - startTime}ms)`,
        );

        // Invalidate cache to get fresh task info with desktop endpoint
        this.invalidateCache(taskId);

        // Get the desktop URL now that it's ready
        const taskInfo = await this.getTaskInfo(taskId);
        if (taskInfo?.desktopEndpoint) {
          return taskInfo.desktopEndpoint;
        }

        // Desktop is ready but no endpoint - shouldn't happen, throw error
        throw new Error(
          `Desktop ready but no endpoint available for task ${taskId}`,
        );
      }

      // Log waiting status
      this.logger.debug(
        `waitForDesktop: Task ${taskId} not ready (attempt ${attempts}): phase=${heartbeat.phase}, message=${heartbeat.message}` +
          (heartbeat.estimatedWaitTime !== undefined
            ? `, estimatedWait=${heartbeat.estimatedWaitTime}s`
            : ''),
      );

      // Wait before next attempt with exponential backoff + jitter
      const jitter = Math.random() * 200; // 0-200ms jitter
      await this.sleep(Math.min(currentDelay + jitter, maxDelayMs));
      currentDelay = Math.min(currentDelay * 1.5, maxDelayMs);
    }

    // Timeout reached
    const elapsed = Date.now() - startTime;
    this.logger.error(
      `waitForDesktop: Timeout waiting for desktop for task ${taskId} after ${attempts} attempts (${elapsed}ms)`,
    );
    throw new Error(
      `Timeout waiting for desktop for task ${taskId} after ${elapsed}ms`,
    );
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get task credentials
   */
  async getCredentials(
    taskId: string,
  ): Promise<{ apiToken: string; vncPassword: string } | null> {
    const taskInfo = await this.getTaskInfo(taskId);
    return taskInfo?.credentials || null;
  }

  /**
   * Post heartbeat to task controller
   * Returns whether the task should continue processing
   *
   * v2.2.1: Now includes `ready` field to indicate when desktop is ready
   * for execution. Agent should check `ready` before executing actions.
   */
  async postHeartbeat(
    taskId: string,
    status?: string,
    currentStep?: string,
  ): Promise<HeartbeatResponse> {
    if (!this.isPhase6Enabled()) {
      // In legacy mode, always continue and always ready
      return {
        acknowledged: true,
        shouldContinue: true,
        ready: true,
        phase: 'Running',
        message: 'Legacy mode - no task controller',
        timeRemaining: 3600,
        warningThreshold: false,
      };
    }

    try {
      const url = `${this.controllerUrl}/api/v1/tasks/${taskId}/heartbeat`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId,
          status,
          currentStep,
        }),
      });

      if (!response.ok) {
        // v2.2.22: Handle 404 with grace window for transient task creation delays
        // This prevents race conditions where heartbeat arrives before TaskDesktop CR is created
        if (response.status === 404) {
          const now = Date.now();
          const graceStart = this.task404GraceStart.get(taskId);

          if (!graceStart) {
            // First 404 for this task - start grace window
            this.task404GraceStart.set(taskId, now);
            this.logger.warn(
              `Heartbeat 404 for ${taskId}: task not found, starting ${this.notFound404GraceMs}ms grace window`,
            );
            // Return shouldContinue: true during grace to allow task controller to create CR
            return {
              acknowledged: false,
              shouldContinue: true,
              ready: false,
              phase: 'Initializing',
              message: `Task ${taskId} not found yet, waiting for creation (grace window started)`,
              timeRemaining: Math.floor(this.notFound404GraceMs / 1000),
              warningThreshold: false,
            };
          }

          const elapsed = now - graceStart;
          if (elapsed < this.notFound404GraceMs) {
            // Still within grace window
            const remaining = this.notFound404GraceMs - elapsed;
            this.logger.debug(
              `Heartbeat 404 for ${taskId}: still in grace window (${Math.round(remaining / 1000)}s remaining)`,
            );
            return {
              acknowledged: false,
              shouldContinue: true,
              ready: false,
              phase: 'Initializing',
              message: `Task ${taskId} not found yet, waiting for creation (${Math.round(remaining / 1000)}s grace remaining)`,
              timeRemaining: Math.floor(remaining / 1000),
              warningThreshold: false,
            };
          }

          // Grace window expired - now treat as permanent failure
          this.logger.error(
            `Heartbeat 404 for ${taskId}: grace window expired after ${Math.round(elapsed / 1000)}s, stopping heartbeat`,
          );
          this.task404GraceStart.delete(taskId); // Clean up
          return {
            acknowledged: false,
            shouldContinue: false, // Signal to stop processing - task really doesn't exist
            ready: false,
            phase: 'NotFound',
            message: `Task ${taskId} not found in task controller after ${Math.round(elapsed / 1000)}s grace window`,
            timeRemaining: 0,
            warningThreshold: false,
          };
        }

        this.logger.warn(`Heartbeat failed for ${taskId}: ${response.status}`);
        // Assume continue on other heartbeat failures, but not ready (unknown state)
        return {
          acknowledged: false,
          shouldContinue: true,
          ready: false,
          phase: 'Unknown',
          message: `Heartbeat failed with status ${response.status}`,
          timeRemaining: 0,
          warningThreshold: false,
        };
      }

      // v2.2.22: Clear 404 grace window on successful response
      if (this.task404GraceStart.has(taskId)) {
        this.logger.log(
          `Heartbeat succeeded for ${taskId}, clearing 404 grace window`,
        );
        this.task404GraceStart.delete(taskId);
      }

      const result = await response.json();

      // v2.2.1: Handle backward compatibility with older task controllers
      const heartbeatResponse: HeartbeatResponse = {
        acknowledged: result.acknowledged ?? false,
        shouldContinue: result.shouldContinue ?? true,
        ready: result.ready ?? result.shouldContinue === true, // fallback for older controllers
        phase: result.phase ?? 'Unknown',
        message: result.message ?? '',
        timeRemaining: result.timeRemaining ?? 0,
        warningThreshold: result.warningThreshold ?? false,
      };

      if (heartbeatResponse.warningThreshold) {
        this.logger.warn(
          `Task ${taskId} approaching timeout: ${heartbeatResponse.timeRemaining}s remaining`,
        );
      }

      if (!heartbeatResponse.shouldContinue) {
        this.logger.log(
          `Task ${taskId} signaled to stop: shouldContinue=false, phase=${heartbeatResponse.phase}`,
        );
      }

      // v2.2.1: Log ready state for debugging
      if (!heartbeatResponse.ready && heartbeatResponse.shouldContinue) {
        this.logger.debug(
          `Task ${taskId} not ready yet: phase=${heartbeatResponse.phase}, message=${heartbeatResponse.message}`,
        );
      }

      return heartbeatResponse;
    } catch (error: any) {
      this.logger.error(`Heartbeat error for ${taskId}: ${error.message}`);
      // Assume continue on error, but not ready
      return {
        acknowledged: false,
        shouldContinue: true,
        ready: false,
        phase: 'Unknown',
        message: `Heartbeat error: ${error.message}`,
        timeRemaining: 0,
        warningThreshold: false,
      };
    }
  }

  /**
   * Start automatic heartbeat for a task
   */
  startHeartbeat(taskId: string): void {
    // Clear any existing heartbeat for this task
    this.stopHeartbeat(taskId);

    if (!this.isPhase6Enabled()) {
      this.logger.debug(
        `Heartbeat not started for ${taskId} - Phase 6 not enabled`,
      );
      return;
    }

    this.logger.log(
      `Starting heartbeat for ${taskId} every ${this.heartbeatIntervalMs}ms`,
    );

    const interval = setInterval(async () => {
      try {
        const result = await this.postHeartbeat(taskId, 'processing');

        if (!result.shouldContinue) {
          this.logger.warn(`Heartbeat indicates task ${taskId} should stop`);
          this.stopHeartbeat(taskId);
        }
      } catch (error: any) {
        this.logger.error(
          `Heartbeat interval error for ${taskId}: ${error.message}`,
        );
      }
    }, this.heartbeatIntervalMs);

    this.heartbeatIntervals.set(taskId, interval);

    // Send initial heartbeat immediately
    this.postHeartbeat(taskId, 'started').catch((error) => {
      this.logger.error(
        `Initial heartbeat failed for ${taskId}: ${error.message}`,
      );
    });
  }

  /**
   * Stop automatic heartbeat for a task
   */
  stopHeartbeat(taskId: string): void {
    const interval = this.heartbeatIntervals.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(taskId);
      this.logger.debug(`Stopped heartbeat for ${taskId}`);
    }
  }

  /**
   * Invalidate cached task info
   */
  invalidateCache(taskId: string): void {
    this.taskCache.delete(taskId);
    this.logger.debug(`Invalidated cache for ${taskId}`);
  }

  /**
   * Get router URL for a task (for VNC connections and action logging)
   */
  async getRouterUrl(taskId: string): Promise<string | null> {
    const taskInfo = await this.getTaskInfo(taskId);
    return taskInfo?.routerUrl || null;
  }

  /**
   * Fallback task info for legacy mode (Phase 6 not deployed)
   */
  private getFallbackTaskInfo(taskId: string): TaskInfo {
    return {
      taskId,
      tenantId: 'default',
      phase: 'Running',
      desktopEndpoint: this.fallbackDesktopUrl,
      vncEndpoint: null,
      routerUrl: '',
      credentials: null,
      timeoutAt: null,
      startedAt: null,
    };
  }
}
