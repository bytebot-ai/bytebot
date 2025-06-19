import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { auth } from './auth';

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    
    try {
      // Convert Express headers to Headers object
      const headers = new Headers();
      Object.entries(request.headers).forEach(([key, value]) => {
        if (typeof value === 'string') {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value[0]);
        }
      });

      const session = await auth.api.getSession({
        headers,
      });

      if (!session) {
        throw new UnauthorizedException('No valid session found');
      }

      // Attach user and session to request for use in controllers
      (request as any).user = session.user;
      (request as any).session = session.session;

      return true;
    } catch (error) {
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
