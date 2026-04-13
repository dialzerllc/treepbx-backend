import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { requireRole } from '../../middleware/roles';
import portal from './portal.routes';
import desktop from './desktop.routes';
import reports from './reports.routes';
import schedule from './schedule.routes';

const agent = new Hono();

agent.use('*', authMiddleware);
agent.use('*', requireRole('agent', 'supervisor', 'tenant_admin'));

agent.route('/portal', portal);
agent.route('/desktop', desktop);
agent.route('/reports', reports);
agent.route('/schedule', schedule);

export default agent;
