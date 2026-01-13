/**
 * ByteBotD - Desktop Daemon for ByteBot
 *
 * v2.0.29: WebSocket stability fixes
 *   - Added server timeout configuration to prevent disconnects
 *   - Node.js 20 defaults keepAliveTimeout to 5000ms which terminates WebSockets
 *   - Added proxy timeout configuration for long-lived VNC connections
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as express from 'express';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Configure body parser with increased payload size limit (50MB)
  app.use(json({ limit: '50mb' }));
  app.use(urlencoded({ limit: '50mb', extended: true }));

  // Enable CORS
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  });

  // v2.0.29: WebSocket proxy with timeout configuration for VNC stability
  const wsProxy = createProxyMiddleware({
    target: 'http://localhost:6080',
    ws: true,
    changeOrigin: true,
    pathRewrite: { '^/websockify': '/' },
    // Disable timeouts for long-lived VNC WebSocket connections
    proxyTimeout: 0,
    timeout: 0,
    on: {
      proxyReqWs: (proxyReq, req, socket) => {
        // Optimize socket for low latency
        if (socket.setNoDelay) {
          socket.setNoDelay(true); // Disable Nagle's algorithm
        }
        if (socket.setKeepAlive) {
          socket.setKeepAlive(true, 30000); // Keep-alive every 30s
        }
      },
    },
  });
  app.use('/websockify', express.raw({ type: '*/*' }), wsProxy);
  const server = await app.listen(9990);

  // v2.0.29: Configure server timeouts for WebSocket stability
  // Node.js 18+ defaults keepAliveTimeout to 5000ms (5 seconds) which causes
  // VNC WebSocket connections to disconnect after ~7 seconds
  // Setting to 0 disables timeouts for long-lived WebSocket connections
  server.keepAliveTimeout = 0;      // Disable keep-alive timeout (default: 5000ms)
  server.headersTimeout = 0;        // Disable headers timeout
  server.requestTimeout = 0;        // Disable request timeout
  server.timeout = 0;               // Disable socket timeout
  console.log('[ByteBotD] Server timeout configuration applied (keepAliveTimeout=0)');

  // Selective upgrade routing
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/websockify')) {
      wsProxy.upgrade(req, socket, head);
    }
    // else let Socket.IO/Nest handle it by not hijacking the socket
  });

  console.log('[ByteBotD] Desktop daemon listening on port 9990 (v2.0.29)');
}
bootstrap();
