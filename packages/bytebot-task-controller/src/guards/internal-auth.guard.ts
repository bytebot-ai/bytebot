/**
 * Internal Authentication Guard
 * v1.0.15: Protects workspace endpoints for internal service-to-service calls only
 *
 * Security Layers:
 * 1. Requires X-Internal-Token header matching configured secret
 * 2. Logs all access attempts with caller context
 * 3. Rejects external/unauthorized requests with 403
 *
 * This guard ensures workspace endpoints are only callable by:
 * - bytebot-workflow-orchestrator
 * - bytebot-agent (if needed)
 * - Other internal services with the shared token
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(InternalAuthGuard.name);
  private readonly internalToken: string | null;
  private readonly enabled: boolean;

  constructor(private configService: ConfigService) {
    // Get the internal token from environment
    this.internalToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN') || null;

    // Guard is enabled if token is configured
    this.enabled = this.configService.get<string>('ENABLE_WORKSPACE_AUTH', 'true') === 'true';

    if (this.enabled && !this.internalToken) {
      this.logger.warn(
        'INTERNAL_SERVICE_TOKEN not configured. Workspace endpoints will reject all requests. ' +
        'Set ENABLE_WORKSPACE_AUTH=false to disable auth (not recommended for production).'
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // Skip auth if disabled (development only)
    if (!this.enabled) {
      this.logger.warn('Internal auth disabled - allowing request (ENABLE_WORKSPACE_AUTH=false)');
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    const callerInfo = this.extractCallerInfo(request);

    // Log all access attempts
    this.logger.log(
      `Workspace endpoint access: ${request.method} ${request.path} ` +
      `caller=${callerInfo.serviceId || 'unknown'} ` +
      `ip=${callerInfo.ip} ` +
      `hasToken=${!!token}`
    );

    // Validate token
    if (!token) {
      this.logger.warn(`Rejected: No X-Internal-Token header from ${callerInfo.ip}`);
      throw new ForbiddenException('Internal service token required');
    }

    if (!this.internalToken) {
      this.logger.error('Rejected: INTERNAL_SERVICE_TOKEN not configured');
      throw new ForbiddenException('Service not configured for internal auth');
    }

    // Constant-time comparison to prevent timing attacks
    const tokenBuffer = Buffer.from(token);
    const expectedBuffer = Buffer.from(this.internalToken);

    if (tokenBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(tokenBuffer, expectedBuffer)) {
      this.logger.warn(
        `Rejected: Invalid token from ${callerInfo.ip} ` +
        `(serviceId=${callerInfo.serviceId || 'unknown'})`
      );
      throw new ForbiddenException('Invalid internal service token');
    }

    // Token valid - log success
    this.logger.debug(
      `Authorized: ${request.method} ${request.path} from ${callerInfo.serviceId || callerInfo.ip}`
    );

    return true;
  }

  /**
   * Extract token from request headers
   * Supports: X-Internal-Token, Authorization: Bearer
   */
  private extractToken(request: Request): string | null {
    // Primary: X-Internal-Token header
    const internalToken = request.headers['x-internal-token'];
    if (internalToken) {
      return Array.isArray(internalToken) ? internalToken[0] : internalToken;
    }

    // Fallback: Authorization Bearer token
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }

  /**
   * Extract caller identification for audit logging
   */
  private extractCallerInfo(request: Request): {
    ip: string;
    serviceId: string | null;
    orgId: string | null;
    workflowRunId: string | null;
  } {
    return {
      ip: request.ip || request.socket.remoteAddress || 'unknown',
      serviceId: this.getHeader(request, 'x-service-id'),
      orgId: this.getHeader(request, 'x-org-id'),
      workflowRunId: this.getHeader(request, 'x-workflow-run-id'),
    };
  }

  private getHeader(request: Request, name: string): string | null {
    const value = request.headers[name];
    if (!value) return null;
    return Array.isArray(value) ? value[0] : value;
  }
}
