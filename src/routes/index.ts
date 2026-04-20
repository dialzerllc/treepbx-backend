import { Hono } from 'hono';
import auth from './auth.routes';
import platform from './platform/index';
import tenant from './tenant/index';
import agent from './agent/index';
import supervisor from './supervisor/index';
import publicRoutes from './public.routes';
import internal from './internal.routes';

const api = new Hono();

api.route('/auth', auth);
api.route('/platform', platform);
api.route('/tenant', tenant);
api.route('/agent', agent);
api.route('/supervisor', supervisor);
api.route('/public', publicRoutes);
api.route('/internal', internal);

export default api;
