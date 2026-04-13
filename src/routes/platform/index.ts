import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { requireRole } from '../../middleware/roles';

import tenantsRouter from './tenants.routes';
import plansRouter from './plans.routes';
import usersRouter from './users.routes';
import carriersRouter from './carriers.routes';
import rateGroupsRouter from './rate-groups.routes';
import platformDidsRouter from './platform-dids.routes';
import gpuServersRouter from './gpu-servers.routes';
import scalingRouter from './scaling.routes';
import gpuScalingRouter from './gpu-scaling.routes';
import liveCallsRouter from './live-calls.routes';
import callTraceRouter from './call-trace.routes';
import fraudRouter from './fraud.routes';
import npanxxRouter from './npanxx.routes';
import auditLogRouter from './audit-log.routes';
import dashboardRouter from './dashboard.routes';

const platform = new Hono();

platform.use('*', authMiddleware);
platform.use('*', requireRole('super_admin', 'platform_supervisor'));

platform.route('/tenants', tenantsRouter);
platform.route('/plans', plansRouter);
platform.route('/users', usersRouter);
platform.route('/carriers', carriersRouter);
platform.route('/rate-groups', rateGroupsRouter);
platform.route('/platform-dids', platformDidsRouter);
platform.route('/gpu-servers', gpuServersRouter);
platform.route('/scaling', scalingRouter);
platform.route('/gpu-scaling', gpuScalingRouter);
platform.route('/live-calls', liveCallsRouter);
platform.route('/call-trace', callTraceRouter);
platform.route('/fraud', fraudRouter);
platform.route('/npanxx', npanxxRouter);
platform.route('/audit-log', auditLogRouter);
platform.route('/dashboard', dashboardRouter);

export default platform;
