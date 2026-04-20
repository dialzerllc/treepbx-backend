import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import { corsMiddleware } from './middleware/cors';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { rateLimit } from './middleware/rate-limit';
import { logger } from './lib/logger';
import api from './routes';

const app = new Hono();

// Security & global middleware
app.use('*', compress());
app.use('*', secureHeaders());
app.use('*', corsMiddleware);
app.use('*', requestIdMiddleware);

// Request logging
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (c.req.path.startsWith('/api/')) {
    logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request');
  }
});

// Error handler
app.onError(errorHandler);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// Rate limits on abuse-prone surfaces (IP-keyed; Redis-backed)
app.use('/api/v1/auth/login',     rateLimit({ max: 10, windowSeconds: 60, prefix: 'login' }));
app.use('/api/v1/auth/refresh',   rateLimit({ max: 20, windowSeconds: 60, prefix: 'refresh' }));
app.use('/api/v1/public/*',       rateLimit({ max: 30, windowSeconds: 60, prefix: 'public' }));

// API routes
app.route('/api/v1', api);

// Frontend dist path — overridable via env so prod (Caddy serves these and
// backend runs without the frontend) and dev (backend serves standalone) both work.
// If the path doesn't resolve, we skip static serving and return 404 for anything
// not matched by /health or /api/v1.
const FRONTEND_DIST = process.env.FRONTEND_DIST_PATH ?? '../treepbx-frontend/dist';
const hasFrontend = await Bun.file(`${FRONTEND_DIST}/index.html`).exists().catch(() => false);

if (hasFrontend) {
  app.use('/assets/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  app.use('/assets/*', serveStatic({ root: FRONTEND_DIST }));
  app.use('/favicon.svg', serveStatic({ path: `${FRONTEND_DIST}/favicon.svg` }));
  app.use('/icons.svg', serveStatic({ path: `${FRONTEND_DIST}/icons.svg` }));

  // SPA fallback — only for non-API paths. Unknown /api/* must 404, not return HTML.
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
    const html = await Bun.file(`${FRONTEND_DIST}/index.html`).text();
    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    c.header('Pragma', 'no-cache');
    return c.html(html);
  });
} else {
  app.get('*', (c) => c.json({ error: 'Not found' }, 404));
}

export default app;
