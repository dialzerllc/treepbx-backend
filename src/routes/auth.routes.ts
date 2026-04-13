import { Hono } from 'hono';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

auth.post('/login', async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const result = await authService.login(body.email, body.password);
  return c.json(result);
});

auth.post('/logout', authMiddleware, async (c) => {
  const user = c.get('user');
  await authService.logout(user.sub);
  return c.json({ ok: true });
});

auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const profile = await authService.getMe(user.sub);
  return c.json(profile);
});

auth.put('/me', authMiddleware, async (c) => {
  // TODO: update profile
  return c.json({ ok: true });
});

export default auth;
