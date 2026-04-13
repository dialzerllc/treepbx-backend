import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { requireRole } from '../../middleware/roles';

import agentsRouter from './agents.routes';
import teamsRouter from './teams.routes';
import skillsRouter from './skills.routes';
import campaignsRouter from './campaigns.routes';
import leadListsRouter from './lead-lists.routes';
import leadsRouter from './leads.routes';
import dncRouter from './dnc.routes';
import dispositionsRouter from './dispositions.routes';
import didsRouter from './dids.routes';
import ivrRouter from './ivr.routes';
import audioRouter from './audio.routes';
import voicebotRouter from './voicebot.routes';
import monitoringRouter from './monitoring.routes';
import reportsRouter from './reports.routes';
import crmRouter from './crm.routes';
import apiKeysRouter from './api-keys.routes';
import walletRouter from './wallet.routes';
import settingsRouter from './settings.routes';
import chatRouter from './chat.routes';
import supportRouter from './support.routes';
import scheduleRouter from './schedule.routes';
import dashboardRouter from './dashboard.routes';

const tenant = new Hono();

// All tenant routes require authentication
tenant.use('*', authMiddleware);

// Base access: any tenant role can access the router; per-route role guards narrow further
tenant.use('*', requireRole('tenant_admin', 'supervisor', 'agent'));

// Dashboard
tenant.route('/dashboard', dashboardRouter);

// Agents & Teams (admin/supervisor create/update; agents read-only via per-route guards)
tenant.route('/agents', agentsRouter);
tenant.route('/teams', teamsRouter);
tenant.route('/skills', skillsRouter);

// Campaign & Dialer
tenant.route('/campaigns', campaignsRouter);
tenant.route('/lead-lists', leadListsRouter);
tenant.route('/leads', leadsRouter);
tenant.route('/dnc', dncRouter);
tenant.route('/dispositions', dispositionsRouter);

// Telephony
tenant.route('/dids', didsRouter);
tenant.route('/ivr', ivrRouter);
tenant.route('/audio', audioRouter);
tenant.route('/voicebot', voicebotRouter);

// Monitoring (supervisor/admin — enforced inside routes)
tenant.route('/monitoring', monitoringRouter);

// Reports (supervisor/admin — enforced inside routes)
tenant.route('/reports', reportsRouter);

// Integrations (admin — enforced inside routes)
tenant.route('/crm', crmRouter);
tenant.route('/api-keys', apiKeysRouter);

// Billing
tenant.route('/wallet', walletRouter);

// Tenant settings
tenant.route('/settings', settingsRouter);

// Communication & Collaboration
tenant.route('/chat', chatRouter);
tenant.route('/support', supportRouter);
tenant.route('/schedule', scheduleRouter);

export default tenant;
