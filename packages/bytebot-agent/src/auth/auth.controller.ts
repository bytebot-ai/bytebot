import { All, Controller, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { auth } from './auth';

@Controller('auth')
export class AuthController {
  @All('*path')
  async handleAuth(@Req() request: Request, @Res() response: Response) {
    // Convert Express request to Web API Request
    const url = `${request.protocol}://${request.get('host')}${request.originalUrl}`;
    
    // Properly handle request body
    let body: string | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers['content-type']?.includes('application/json')) {
        body = JSON.stringify(request.body);
      } else {
        body = request.body;
      }
    }

    // Create headers object including cookies
    const headers = new Headers();
    Object.entries(request.headers).forEach(([key, value]) => {
      if (typeof value === 'string') {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        headers.set(key, value[0]);
      }
    });

    const webRequest = new Request(url, {
      method: request.method,
      headers,
      body,
    });

    const result = await auth.handler(webRequest);
    
    // Handle the response
    if (result instanceof Response) {
      const body = await result.text();
      
      // Copy headers from the Better Auth response
      result.headers.forEach((value, key) => {
        response.setHeader(key, value);
      });
      
      response.status(result.status).send(body);
    } else {
      response.json(result);
    }
  }
}
