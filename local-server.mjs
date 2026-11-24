import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApiGuard } from './server/local-api-guard.mjs';
import { registerQQMusicExpressRoutes } from './server/qq-music.mjs';
import { registerNeteaseMusicExpressRoutes } from './server/netease-music.mjs';
import { registerKugouMusicExpressRoutes } from './server/kugou-music.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCAL_PORT = 45437;

export function createLocalServerApp(guardOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(createLocalApiGuard(guardOptions));
  app.use(express.json({ limit: '256kb' }));
  registerQQMusicExpressRoutes(app);
  registerNeteaseMusicExpressRoutes(app);
  registerKugouMusicExpressRoutes(app);
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_request, response) => {
    response.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
  return app;
}

function listenOnce(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: actualPort, url: `http://${host}:${actualPort}` });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 启动本地 HTTP 服务：优先绑定 preferredPort，若遇到 EADDRINUSE 自动向后探测空闲端口，
 * 若连续探测仍被占用则回退到系统自动分配端口（0），避免因端口冲突导致应用崩溃。
 */
export async function startLocalServer({
  port = Number(process.env.PORT || DEFAULT_LOCAL_PORT),
  host = '127.0.0.1',
  maxPortRetries = 30,
  guardOptions = {},
} = {}) {
  const app = createLocalServerApp(guardOptions);
  const startPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_LOCAL_PORT;
  const candidates = [];
  if (startPort === 0) {
    candidates.push(0);
  } else {
    const attempts = Math.max(1, Number(maxPortRetries) || 1);
    for (let offset = 0; offset < attempts && startPort + offset <= 65535; offset += 1) {
      candidates.push(startPort + offset);
    }
    candidates.push(0);
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const started = await listenOnce(app, candidate, host);
      if (startPort > 0 && started.port !== startPort) {
        console.warn(`[local-server] 端口 ${startPort} 已被占用，已自动切换至 ${started.url}`);
      } else {
        console.log(`ORBIT Music is running at ${started.url}`);
      }
      return started;
    } catch (error) {
      if (error?.code === 'EADDRINUSE' && candidate !== 0) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error('无法为 ORBIT 本地服务分配可用端口');
}

const isDirectEntry = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  startLocalServer().catch((error) => {
    console.error('[local-server] 启动失败:', error?.message || error);
    process.exit(1);
  });
}
