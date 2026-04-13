import { env } from './env';
import { initKeys } from './lib/jwt';
import { logger } from './lib/logger';
import app from './app';
import { upgradeWebSocket, wsHandler } from './ws';

async function main() {
  await initKeys();
  logger.info('JWT keys loaded');

  const server = Bun.serve({
    port: env.PORT,
    hostname: '0.0.0.0',
    fetch(req, server) {
      // WebSocket upgrade for /ws path
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        return upgradeWebSocket(req, server) as Promise<Response>;
      }
      return app.fetch(req);
    },
    websocket: wsHandler,
  });

  logger.info(`TreePBX Backend running on http://localhost:${server.port}`);
  logger.info(`WebSocket available at ws://localhost:${server.port}/ws`);
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start server');
  process.exit(1);
});
