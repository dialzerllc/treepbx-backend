import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { requireRole } from '../../middleware/roles';
import supervisor from './supervisor.routes';

const sup = new Hono();

sup.use('*', authMiddleware);
sup.use('*', requireRole('supervisor', 'tenant_admin'));

sup.route('/', supervisor);

export default sup;
