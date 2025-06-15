const express = require('express');
const next = require('next');
const http = require('http');
const { createProxyMiddleware } = require('http-proxy-middleware');

const port = parseInt(process.env.PORT, 10) || 9992;
const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const agentWsProxy = createProxyMiddleware('/socket.io', {
  target: process.env.BYTEBOT_AGENT_BASE_URL,
  changeOrigin: true,
  ws: true,
});

const vncWsProxy = createProxyMiddleware('/websockify', {
  target: process.env.BYTEBOT_DESKTOP_VNC_URL,
  changeOrigin: true,
  ws: true,
});

app.prepare().then(() => {
  const server = express();

  server.use(agentWsProxy);
  server.use('/websockify', vncWsProxy);

  server.all('*', (req, res) => handle(req, res));

  const httpServer = http.createServer(server);

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/socket.io')) {
      agentWsProxy.upgrade(req, socket, head);
    } else if (req.url.startsWith('/websockify')) {
      vncWsProxy.upgrade(req, socket, head);
    }
  });

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
