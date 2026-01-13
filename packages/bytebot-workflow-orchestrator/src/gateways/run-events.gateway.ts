/**
 * Run Events Gateway
 * Phase 5: Real-Time Event System
 *
 * WebSocket gateway for broadcasting goal run events in real-time:
 * - Run status changes
 * - Step progress updates
 * - Activity events
 * - Desktop status changes
 * - Metrics updates
 */

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, UseFilters } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';

// Event types for type safety
export type RunEventType =
  | 'run:started'
  | 'run:paused'
  | 'run:resumed'
  | 'run:completed'
  | 'run:failed'
  | 'run:cancelled'
  | 'run:phase_changed'
  | 'run:intervened'
  | 'run:control_returned'
  | 'step:started'
  | 'step:completed'
  | 'step:failed'
  | 'step:approved'
  | 'step:rejected'
  | 'approval:requested'
  | 'activity:logged'
  | 'desktop:status_changed'
  | 'desktop:waking'
  | 'screenshot:captured'
  | 'metrics:updated';

export interface RunEvent<T = any> {
  type: RunEventType;
  runId: string;
  timestamp: Date;
  data: T;
}

// Extended Socket interface with authentication data
// Socket already has id, join, leave, emit, etc. from socket.io
interface AuthenticatedSocket extends Socket {
  userId?: string;
  tenantId?: string;
  email?: string;
  // Re-declare id to ensure TypeScript recognizes it
  id: string;
}

@Injectable()
@WebSocketGateway({
  namespace: '/ws/runs',
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
})
export class RunEventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RunEventsGateway.name);

  // Track run subscriptions: runId -> Set<clientId>
  private runSubscriptions = new Map<string, Set<string>>();

  // Track client metadata: clientId -> { tenantId, userId }
  private clientMetadata = new Map<string, { tenantId: string; userId: string }>();

  constructor(private jwtService: JwtService) {}

  afterInit(server: Server) {
    this.logger.log('Run Events Gateway initialized');

    // Authentication middleware
    server.use(async (socket: AuthenticatedSocket, next) => {
      try {
        const token = socket.handshake.auth?.token;

        if (token) {
          const decoded = this.jwtService.verify(token);
          socket.userId = decoded.userId || decoded.sub;
          socket.tenantId = decoded.tenantId || decoded.tenant_id;
          socket.email = decoded.email;
        }

        next();
      } catch (error: any) {
        this.logger.warn(`Authentication failed: ${error.message}`);
        // Allow connection but mark as unauthenticated
        next();
      }
    });
  }

  handleConnection(@ConnectedSocket() client: AuthenticatedSocket) {
    this.logger.log(
      `Client ${client.id} connected (tenant: ${client.tenantId}, user: ${client.userId})`,
    );

    if (client.tenantId && client.userId) {
      this.clientMetadata.set(client.id, {
        tenantId: client.tenantId,
        userId: client.userId,
      });

      // Join tenant room
      client.join(`tenant:${client.tenantId}`);

      // Join user room
      client.join(`user:${client.userId}`);
    }

    // Send connection confirmation
    client.emit('connection:established', {
      clientId: client.id,
      authenticated: !!client.tenantId,
      timestamp: new Date(),
    });
  }

  handleDisconnect(@ConnectedSocket() client: AuthenticatedSocket) {
    this.logger.log(`Client ${client.id} disconnected`);

    // Clean up subscriptions
    this.runSubscriptions.forEach((subscribers, runId) => {
      if (subscribers.has(client.id)) {
        subscribers.delete(client.id);
        if (subscribers.size === 0) {
          this.runSubscriptions.delete(runId);
        }
      }
    });

    // Clean up metadata
    this.clientMetadata.delete(client.id);
  }

  /**
   * Client subscribes to a specific run's events
   */
  @SubscribeMessage('subscribe:run')
  handleSubscribeToRun(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { runId: string },
  ) {
    const { runId } = data;
    const roomName = `run:${runId}`;

    // TODO: Verify tenant access to this run

    client.join(roomName);

    if (!this.runSubscriptions.has(runId)) {
      this.runSubscriptions.set(runId, new Set());
    }
    this.runSubscriptions.get(runId)?.add(client.id);

    this.logger.debug(
      `Client ${client.id} subscribed to run ${runId} (${this.runSubscriptions.get(runId)?.size} subscribers)`,
    );

    client.emit('subscription:confirmed', {
      runId,
      subscribed: true,
      subscriberCount: this.runSubscriptions.get(runId)?.size || 0,
    });
  }

  /**
   * Client unsubscribes from a run
   */
  @SubscribeMessage('unsubscribe:run')
  handleUnsubscribeFromRun(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { runId: string },
  ) {
    const { runId } = data;
    const roomName = `run:${runId}`;

    client.leave(roomName);

    this.runSubscriptions.get(runId)?.delete(client.id);
    if (this.runSubscriptions.get(runId)?.size === 0) {
      this.runSubscriptions.delete(runId);
    }

    this.logger.debug(`Client ${client.id} unsubscribed from run ${runId}`);

    client.emit('subscription:cancelled', { runId });
  }

  /**
   * Broadcast event to all subscribers of a run
   */
  broadcastToRun(runId: string, event: RunEvent) {
    this.server.to(`run:${runId}`).emit(event.type, event);
    this.logger.debug(`Broadcast ${event.type} to run ${runId}`);
  }

  /**
   * Broadcast event to all clients in a tenant
   */
  broadcastToTenant(tenantId: string, event: RunEvent) {
    this.server.to(`tenant:${tenantId}`).emit(event.type, event);
  }

  /**
   * Get subscriber count for a run
   */
  getRunSubscriberCount(runId: string): number {
    return this.runSubscriptions.get(runId)?.size || 0;
  }

  // ==========================================
  // Event Handlers - Listen to internal events
  // ==========================================

  @OnEvent('goal-run.started')
  handleRunStarted(payload: { goalRunId: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:started',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.paused')
  handleRunPaused(payload: { goalRunId: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:paused',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.resumed')
  handleRunResumed(payload: { goalRunId: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:resumed',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.completed')
  handleRunCompleted(payload: { goalRunId: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:completed',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.failed')
  handleRunFailed(payload: { goalRunId: string; error: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:failed',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.cancelled')
  handleRunCancelled(payload: { goalRunId: string; reason?: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:cancelled',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.phase-changed')
  handlePhaseChanged(payload: {
    goalRunId: string;
    previousPhase: string;
    newPhase: string;
  }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:phase_changed',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.intervened')
  handleIntervened(payload: { goalRunId: string; userId?: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:intervened',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('goal-run.control-returned')
  handleControlReturned(payload: { goalRunId: string; userId?: string }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'run:control_returned',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('step.approved')
  handleStepApproved(payload: {
    goalRunId: string;
    stepId: string;
    userId?: string;
  }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'step:approved',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('step.rejected')
  handleStepRejected(payload: {
    goalRunId: string;
    stepId: string;
    reason: string;
    userId?: string;
  }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'step:rejected',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('activity-event.created')
  handleActivityEvent(payload: {
    goalRunId: string;
    eventType: string;
    title: string;
    description?: string;
    severity?: string;
    details?: Record<string, any>;
  }) {
    this.broadcastToRun(payload.goalRunId, {
      type: 'activity:logged',
      runId: payload.goalRunId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('desktop.waking')
  handleDesktopWaking(payload: { runId: string }) {
    this.broadcastToRun(payload.runId, {
      type: 'desktop:waking',
      runId: payload.runId,
      timestamp: new Date(),
      data: payload,
    });
  }

  @OnEvent('screenshot.captured')
  handleScreenshotCaptured(payload: {
    runId: string;
    screenshot: {
      id: string;
      url: string;
      timestamp: Date;
      stepId?: string;
      stepDescription?: string;
    };
  }) {
    this.broadcastToRun(payload.runId, {
      type: 'screenshot:captured',
      runId: payload.runId,
      timestamp: new Date(),
      data: payload.screenshot,
    });
  }
}
