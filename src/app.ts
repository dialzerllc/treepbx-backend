import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { corsMiddleware } from './middleware/cors';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import api from './routes';

const app = new Hono();

// Global middleware
app.use('*', corsMiddleware);
app.use('*', requestIdMiddleware);

// Error handler
app.onError(errorHandler);

// Health check
app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// API routes
app.route('/api/v1', api);

// Serve frontend static files (assets are hashed, cache forever)
app.use('/assets/*', serveStatic({ root: '../treepbx-frontend/dist' }));
app.use('/favicon.svg', serveStatic({ path: '../treepbx-frontend/dist/favicon.svg' }));
app.use('/icons.svg', serveStatic({ path: '../treepbx-frontend/dist/icons.svg' }));

// SPA fallback — serve index.html with no-cache to always get fresh build
app.get('*', async (c) => {
  const file = Bun.file('../treepbx-frontend/dist/index.html');
  const html = await file.text();
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  c.header('Pragma', 'no-cache');
  return c.html(html);
});

export default app;
