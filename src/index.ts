import { createServer } from 'http';
import { env } from './env';
import { initKeys } from './lib/jwt';
import { logger } from './lib/logger';
import { initSocketIO } from './lib/socketio';
import app from './app';
import { upgradeWebSocket, upgradeTerminalWebSocket, wsHandler } from './ws';
import { startWorkers } from './lib/queue';

async function main() {
  await initKeys();
  logger.info('JWT keys loaded');

  const server = Bun.serve({
    port: env.PORT,
    hostname: '0.0.0.0',
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const resp = await upgradeWebSocket(req, server);
        // undefined means upgrade succeeded
        return resp ?? new Response(null, { status: 101 });
      }
      if (url.pathname === '/debug-terminal') {
        const resp = await upgradeTerminalWebSocket(req, server);
        return resp ?? new Response(null, { status: 101 });
      }
      return app.fetch(req);
    },
    websocket: {
      ...wsHandler,
      idleTimeout: 120, // 2 minutes idle timeout (default is 30s)
      maxPayloadLength: 64 * 1024,
    },
  });

  logger.info(`TreePBX Backend running on http://localhost:${server.port}`);
  logger.info(`WebSocket available at ws://localhost:${server.port}/ws`);

  // Socket.IO on separate HTTP server (Bun.serve doesn't support direct attachment)
  const httpServer = createServer();
  initSocketIO(httpServer);
  httpServer.listen(3001, () => logger.info('Socket.IO on port 3001'));

  startWorkers();

  // Start carrier health check
  const { startCarrierHealthCheck } = await import('./esl/health-check');
  startCarrierHealthCheck();

  // Autoscaler loop (runs every 30s; no-op unless autoscaler_enabled=true in platform_settings)
  {
    const { runAutoscalerTick } = await import('./autoscaler');
    setInterval(() => {
      runAutoscalerTick().catch((err) => logger.error({ err }, '[autoscaler] tick crashed'));
    }, 30_000);
    logger.info('[autoscaler] loop started (30s; shadow mode by default)');
  }

  // Connect to FreeSWITCH ESL
  try {
    const { eslClient } = await import('./esl/client');
    const { startESLEventListener } = await import('./esl/events');
    eslClient.connect().then(async () => {
      startESLEventListener();
      logger.info('FreeSWITCH ESL connected');

      // Resume dialers for any campaigns in running state
      try {
        const { startCampaignDialer } = await import('./esl/dialer');
        const { db } = await import('./db/client');
        const { campaigns } = await import('./db/schema');
        const { eq } = await import('drizzle-orm');
        const running = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, 'running'));
        for (const c of running) {
          startCampaignDialer(c.id);
        }
        if (running.length > 0) logger.info({ count: running.length }, 'Resumed campaign dialers');
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Failed to resume campaign dialers');
      }
    }).catch((err: any) => {
      logger.warn({ err: err.message }, 'FreeSWITCH ESL not available — will retry');
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'FreeSWITCH ESL init failed — calls via FS disabled');
  }
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start server');
  process.exit(1);
});
