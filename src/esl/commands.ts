import { eslClient } from './client';
import { db } from '../db/client';
import { carriers, mediaNodes, users, dids, agentDids } from '../db/schema';
import { eq, and, inArray, asc, sql, isNull } from 'drizzle-orm';
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { logger } from '../lib/logger';

const DEFAULT_GATEWAY = process.env.FS_DEFAULT_GATEWAY ?? 'OTB2';

export async function getOutboundGateways(): Promise<string[]> {
  try {
    const platformCarriers = await db.select({ name: carriers.name })
      .from(carriers)
      .where(and(
        eq(carriers.status, 'active'),
        inArray(carriers.direction, ['outbound', 'both']),
      ))
      .orderBy(asc(carriers.priority));
    if (platformCarriers.length > 0) {
      return platformCarriers.map(c => c.name);
    }
  } catch {}
  return [DEFAULT_GATEWAY];
}

export function originate(destination: string, callerId: string, gateway = DEFAULT_GATEWAY, extension = 'park', context = 'default') {
  eslClient.bgapi(`originate {origination_caller_id_number=${callerId}}sofia/gateway/${gateway}/${destination} ${extension} XML ${context}`);
}

export function hangup(uuid: string, cause = 'NORMAL_CLEARING') {
  eslClient.api(`uuid_kill ${uuid} ${cause}`);
}

export function hold(uuid: string) {
  eslClient.api(`uuid_hold ${uuid}`);
}

export function unhold(uuid: string) {
  eslClient.api(`uuid_hold off ${uuid}`);
}

export function transfer(uuid: string, destination: string, context = 'default') {
  eslClient.api(`uuid_transfer ${uuid} ${destination} XML ${context}`);
}

export function bridge(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_bridge ${uuid} ${targetUuid}`);
}

export function record(uuid: string, path: string) {
  eslClient.api(`uuid_record ${uuid} start ${path}`);
}

export function stopRecord(uuid: string) {
  eslClient.api(`uuid_record ${uuid} stop all`);
}

export function eavesdrop(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_bridge ${uuid} ${targetUuid}`);
}

export function whisper(uuid: string, targetUuid: string) {
  eslClient.api(`uuid_broadcast ${targetUuid} eavesdrop::${uuid} aleg`);
}

export function mute(uuid: string) {
  eslClient.api(`uuid_audio ${uuid} start write mute`);
}

export function unmute(uuid: string) {
  eslClient.api(`uuid_audio ${uuid} stop`);
}

// ── Gateway management ─────────────────────────────────────────────────
//
// Gateways live as XML files inside each FreeSWITCH container's
// /etc/freeswitch/sip_profiles/external/ directory. When the autoscaler
// or carrier-routes mutates a gateway, we have to push the XML to every
// active FreeSWITCH node and ask each to `sofia profile external rescan`.
//
// FS now lives on remote fleet boxes (one per fs node), so the historical
// "docker cp localhost" pattern doesn't work. We:
//   1. Look up active freeswitch media_nodes from the DB (control plane truth).
//   2. SSH to each via the autoscaler bootstrap key (which they already trust).
//   3. docker cp the XML into the `fs` container; fs_cli rescan locally.
//
// SSH key + ESL password come from the same .env that the rest of the
// backend uses. If the key isn't set we log and bail — better to refuse
// than to silently leak a half-provisioned gateway.

const SSH_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH ?? '/opt/tpbx/secrets/ssh_key';
const SSH_USER = process.env.SSH_USER ?? 'root';
const ESL_PW_FOR_SHIP = process.env.FREESWITCH_ESL_PASSWORD ?? 'ClueCon';
const DOCKER_CONTAINER = process.env.FREESWITCH_CONTAINER ?? 'fs';

async function getActiveFreeswitchNodes(): Promise<string[]> {
  try {
    const rows = await db.select({ ip: mediaNodes.publicIp })
      .from(mediaNodes)
      .where(and(eq(mediaNodes.serviceType, 'freeswitch'), eq(mediaNodes.state, 'active')));
    return rows.map((r) => r.ip);
  } catch (err) {
    logger.warn({ err }, '[esl] could not list active freeswitch nodes');
    return [];
  }
}

function sshArgs(ip: string): string[] {
  return [
    '-i', SSH_KEY_PATH,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-o', 'BatchMode=yes',
    `${SSH_USER}@${ip}`,
  ];
}

function pushXmlToNode(ip: string, name: string, localPath: string): void {
  // scp file → /tmp on the node
  execFileSync('scp', [
    '-i', SSH_KEY_PATH,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-o', 'BatchMode=yes',
    localPath,
    `${SSH_USER}@${ip}:/tmp/${name}.xml`,
  ], { timeout: 12000 });

  // docker cp → container; rescan profile
  execFileSync('ssh', [
    ...sshArgs(ip),
    `docker cp /tmp/${name}.xml ${DOCKER_CONTAINER}:/etc/freeswitch/sip_profiles/external/${name}.xml && ` +
    `docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'sofia profile external rescan' && ` +
    `rm -f /tmp/${name}.xml`,
  ], { timeout: 15000 });
}

function killGwOnNode(ip: string, name: string): void {
  execFileSync('ssh', [
    ...sshArgs(ip),
    `docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'sofia profile external killgw ${name}' && ` +
    `docker exec ${DOCKER_CONTAINER} rm -f /etc/freeswitch/sip_profiles/external/${name}.xml`,
  ], { timeout: 10000 });
}

export async function addGateway(rawName: string, opts: {
  host: string;
  port?: number;
  transport?: string;
  username?: string;
  password?: string;
  register?: boolean;
  expiry?: number;
}): Promise<boolean> {
  // Sanitize: FS gateway names must match [a-zA-Z0-9_-]
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const xml = `<include>
  <gateway name="${name}">
    <param name="realm" value="${opts.host}"/>
    <param name="proxy" value="${opts.host}:${opts.port || 5060}"/>
    <param name="register" value="${opts.register !== false ? 'true' : 'false'}"/>
    ${opts.username ? `<param name="username" value="${opts.username}"/>` : ''}
    ${opts.password ? `<param name="password" value="${opts.password}"/>` : ''}
    <param name="expire-seconds" value="${opts.expiry || 3600}"/>
    <param name="register-transport" value="${(opts.transport || 'UDP').toLowerCase()}"/>
    <param name="retry-seconds" value="30"/>
    <param name="caller-id-in-from" value="true"/>
  </gateway>
</include>`;

  const localPath = `/tmp/fs_gateway_${name}.xml`;
  try {
    writeFileSync(localPath, xml);
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err), name }, '[esl] could not write gateway xml');
    return false;
  }

  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) {
    logger.warn({ name }, '[esl] no active freeswitch nodes — gateway xml staged but not pushed');
    try { unlinkSync(localPath); } catch {}
    return false;
  }

  let allOk = true;
  for (const ip of fsNodes) {
    try {
      pushXmlToNode(ip, name, localPath);
      logger.info({ ip, gateway: name }, '[esl] gateway provisioned');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip, gateway: name }, '[esl] gateway push failed');
      allOk = false;
    }
  }
  try { unlinkSync(localPath); } catch {}
  return allOk;
}

export async function removeGateway(rawName: string): Promise<boolean> {
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) return false;

  let allOk = true;
  for (const ip of fsNodes) {
    try {
      killGwOnNode(ip, name);
      logger.info({ ip, gateway: name }, '[esl] gateway removed');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip, gateway: name }, '[esl] gateway removal failed');
      allOk = false;
    }
  }
  return allOk;
}

// SIP user directory provisioning — fans out an XML user file to every active
// freeswitch node and triggers reloadxml so a new agent's softphone can
// register. Idempotent (overwrite). Without this every newly-created agent
// gets 403 from FS until manually added — same incident pattern as the
// /platform/carriers→addGateway flow but for users instead of gateways.
function pushUserXmlToNode(ip: string, sipUsername: string, localPath: string): void {
  execFileSync('scp', [
    '-i', SSH_KEY_PATH,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-o', 'BatchMode=yes',
    localPath,
    `${SSH_USER}@${ip}:/tmp/${sipUsername}.xml`,
  ], { timeout: 12000 });
  execFileSync('ssh', [
    ...sshArgs(ip),
    `docker cp /tmp/${sipUsername}.xml ${DOCKER_CONTAINER}:/etc/freeswitch/directory/default/${sipUsername}.xml && ` +
    `docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'reloadxml' && ` +
    `rm -f /tmp/${sipUsername}.xml`,
  ], { timeout: 15000 });
}

function removeUserXmlOnNode(ip: string, sipUsername: string): void {
  execFileSync('ssh', [
    ...sshArgs(ip),
    `docker exec ${DOCKER_CONTAINER} rm -f /etc/freeswitch/directory/default/${sipUsername}.xml && ` +
    `docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'reloadxml'`,
  ], { timeout: 10000 });
}

/** Provision (or refresh) an FS directory entry for an agent. Safe to call on
 *  every agent create/update — overwrites the file. Returns true if at least
 *  one fs node accepted the change. */
// Resolve the outbound caller-ID number + display name for an agent. Used by
// pushSipUser (FS directory) AND by the click-to-call origin flow in
// ws/handlers.ts so both paths present the same caller-ID. Order:
//   1. agent's first assigned DID (agent_dids → dids)
//   2. tenant's first active DID
//   3. null (fall back to FS global ${outbound_caller_id} or extension)
export async function resolveOutboundCallerId(agentId: string): Promise<{ number: string | null; name: string | null }> {
  try {
    const [agent] = await db.select({
      id: users.id,
      tenantId: users.tenantId,
      firstName: users.firstName,
      lastName: users.lastName,
    }).from(users)
      .where(and(eq(users.id, agentId), isNull(users.deletedAt)))
      .limit(1);
    if (!agent) return { number: null, name: null };
    const name = `${agent.firstName ?? ''} ${agent.lastName ?? ''}`.trim() || null;
    const [assigned] = await db.select({ number: dids.number })
      .from(agentDids)
      .innerJoin(dids, eq(dids.id, agentDids.didId))
      .where(and(eq(agentDids.agentId, agent.id), eq(dids.active, true)))
      .limit(1);
    if (assigned) return { number: assigned.number, name };
    if (agent.tenantId) {
      const [tenantDid] = await db.select({ number: dids.number })
        .from(dids)
        .where(and(eq(dids.tenantId, agent.tenantId), eq(dids.active, true)))
        .limit(1);
      if (tenantDid) return { number: tenantDid.number, name };
    }
    return { number: null, name };
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err), agentId }, '[esl] resolveOutboundCallerId failed');
    return { number: null, name: null };
  }
}

async function resolveOutboundCallerIdBySip(sipUsername: string): Promise<{ number: string | null; name: string | null }> {
  const [agent] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.sipUsername, sipUsername), isNull(users.deletedAt)))
    .limit(1);
  if (!agent) return { number: null, name: null };
  return resolveOutboundCallerId(agent.id);
}

export async function pushSipUser(sipUsername: string): Promise<boolean> {
  if (!/^\d{1,4}$/.test(sipUsername)) {
    logger.warn({ sipUsername }, '[esl] invalid sip username — skipping directory push');
    return false;
  }

  const { number: outboundCallerNumber, name: displayName } = await resolveOutboundCallerIdBySip(sipUsername);

  const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cidNumber = outboundCallerNumber ?? `$\${outbound_caller_id}`;
  const cidName = displayName ? escapeXml(displayName) : `$\${outbound_caller_name}`;

  // Password references default_password (set in vars.xml at bootstrap), so
  // rotating that one variable rolls every agent's REGISTER credential.
  const xml = `<include>
  <user id="${sipUsername}">
    <params>
      <param name="password" value="$\${default_password}"/>
    </params>
    <variables>
      <variable name="user_context" value="default"/>
      <variable name="effective_caller_id_name" value="${cidName}"/>
      <variable name="effective_caller_id_number" value="${cidNumber}"/>
      <variable name="outbound_caller_id_name" value="${cidName}"/>
      <variable name="outbound_caller_id_number" value="${cidNumber}"/>
    </variables>
  </user>
</include>`;
  const localPath = `/tmp/fs_user_${sipUsername}.xml`;
  try { writeFileSync(localPath, xml); }
  catch (err: any) {
    logger.error({ err: err?.message ?? String(err), sipUsername }, '[esl] could not write user xml');
    return false;
  }
  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) {
    logger.warn({ sipUsername }, '[esl] no active fs nodes — user xml staged but not pushed');
    try { unlinkSync(localPath); } catch {}
    return false;
  }
  let anyOk = false;
  for (const ip of fsNodes) {
    try { pushUserXmlToNode(ip, sipUsername, localPath); anyOk = true;
      logger.info({ ip, sipUsername }, '[esl] sip user provisioned');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip, sipUsername }, '[esl] sip user push failed');
    }
  }
  try { unlinkSync(localPath); } catch {}
  return anyOk;
}

/** Remove a directory entry from every fs node. Used on agent delete or when
 *  the agent's sipUsername changes (the OLD username's file should go away). */
export async function removeSipUser(sipUsername: string): Promise<boolean> {
  if (!/^\d{1,4}$/.test(sipUsername)) return false;
  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) return false;
  let anyOk = false;
  for (const ip of fsNodes) {
    try { removeUserXmlOnNode(ip, sipUsername); anyOk = true;
      logger.info({ ip, sipUsername }, '[esl] sip user removed');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip, sipUsername }, '[esl] sip user removal failed');
    }
  }
  return anyOk;
}

// Re-provision every directory entry under a tenant. Triggered when something
// the user XML embeds (DID assignments, tenant DIDs) changes — without this
// the directory entry keeps the caller-id resolved at the previous push and
// new DIDs only take effect after the next agent edit.
export async function repushSipUsersForTenant(tenantId: string): Promise<{ ok: number; total: number }> {
  const rows = await db.select({ sipUsername: users.sipUsername }).from(users)
    .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)));
  let ok = 0;
  for (const r of rows) {
    if (!r.sipUsername) continue;
    try {
      const pushed = await pushSipUser(r.sipUsername);
      if (pushed) ok++;
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), sipUsername: r.sipUsername }, '[esl] tenant repush: per-user push failed');
    }
  }
  logger.info({ tenantId, ok, total: rows.length }, '[esl] tenant repush complete');
  return { ok, total: rows.length };
}

// Re-provision every directory entry across all tenants. Use sparingly — it
// fans out to every fs node once per agent. Intended for one-off admin runs.
export async function repushAllSipUsers(): Promise<{ ok: number; total: number }> {
  const rows = await db.select({ sipUsername: users.sipUsername }).from(users)
    .where(isNull(users.deletedAt));
  let ok = 0;
  for (const r of rows) {
    if (!r.sipUsername) continue;
    try {
      if (await pushSipUser(r.sipUsername)) ok++;
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), sipUsername: r.sipUsername }, '[esl] full repush: per-user push failed');
    }
  }
  logger.info({ ok, total: rows.length }, '[esl] full repush complete');
  return { ok, total: rows.length };
}

// Regenerate the inbound DID dialplan from the database and push it to every
// fs node. Each active DID with routeType='extension' becomes one extension
// rule that bridges to user/<sipUsername>. Other route types fall through to
// the unrouted-default rule (404) until they're explicitly supported.
//
// Drop-in: writes /etc/freeswitch/dialplan/public/01_dids.xml. Public dialplan
// already has 00_test-inbound.xml (9999 smoke + catch-all 503). Ours sorts
// before the catch-all by filename, so a matched DID wins.
export async function syncInboundDidDialplan(): Promise<boolean> {
  // Pull active DIDs that have a usable extension target. Join into users to
  // resolve sipUsername. We only emit rules for DIDs that have a working
  // mapping today; the others drop through to 503.
  const rows = await db.execute(sql`
    SELECT d.number, u.sip_username
    FROM dids d
    JOIN users u ON u.id = d.route_target_id
    WHERE d.active = true
      AND d.route_type = 'extension'
      AND u.sip_username IS NOT NULL
      AND u.deleted_at IS NULL
  `);
  // execute returns { rows: [...] } in postgres-js but the runtime adapter
  // may return the array directly — handle both.
  const list: Array<{ number: string; sip_username: string }> = (rows as any).rows ?? (rows as any);

  const xmlEscape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));
  let body = '<include>\n';
  for (const r of list) {
    const num = (r.number ?? '').replace(/[^\d+]/g, '');
    const ext = (r.sip_username ?? '').replace(/[^\d]/g, '');
    if (!num || !ext) continue;
    body += `  <extension name="did_${xmlEscape(num)}">\n`;
    body += `    <condition field="destination_number" expression="^\\+?${num.replace(/^\+/, '')}$">\n`;
    body += `      <action application="set" data="hangup_after_bridge=true"/>\n`;
    body += `      <action application="bridge" data="user/${ext}"/>\n`;
    body += `    </condition>\n`;
    body += `  </extension>\n`;
  }
  body += '</include>\n';

  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) {
    logger.warn({}, '[esl] no active fs nodes — DID dialplan not pushed');
    return false;
  }
  const localPath = '/tmp/fs_dids.xml';
  try { writeFileSync(localPath, body); }
  catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, '[esl] could not write DID dialplan');
    return false;
  }
  let anyOk = false;
  for (const ip of fsNodes) {
    try {
      execFileSync('scp', [
        '-i', SSH_KEY_PATH,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=5',
        '-o', 'BatchMode=yes',
        localPath,
        `${SSH_USER}@${ip}:/tmp/01_dids.xml`,
      ], { timeout: 12000 });
      execFileSync('ssh', [
        ...sshArgs(ip),
        `docker cp /tmp/01_dids.xml ${DOCKER_CONTAINER}:/etc/freeswitch/dialplan/public/01_dids.xml && ` +
        `docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'reloadxml' && ` +
        `rm -f /tmp/01_dids.xml`,
      ], { timeout: 12000 });
      anyOk = true;
      logger.info({ ip, didCount: list.length }, '[esl] DID dialplan synced');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip }, '[esl] DID dialplan push failed');
    }
  }
  try { unlinkSync(localPath); } catch {}
  return anyOk;
}

// Promote a gateway to default outbound carrier across the fleet. Updates
// vars.xml's default_outbound_gateway on every active fs node and reloadxml's
// so the dialplan rule (sofia/gateway/${default_outbound_gateway}/...) picks
// the new value without rewriting the dialplan itself.
export async function setDefaultOutboundGateway(rawName: string): Promise<boolean> {
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fsNodes = await getActiveFreeswitchNodes();
  if (fsNodes.length === 0) {
    logger.warn({ name }, '[esl] no active fs nodes — default gateway change not applied');
    return false;
  }
  let anyOk = false;
  for (const ip of fsNodes) {
    try {
      execFileSync('ssh', [
        ...sshArgs(ip),
        // Replace existing line OR append if missing. The line lives in vars.xml
        // alongside default_password (set by freeswitch-bootstrap.sh).
        `docker exec ${DOCKER_CONTAINER} sh -c '` +
          `grep -q default_outbound_gateway /etc/freeswitch/vars.xml ` +
          `&& sed -i "s|.*default_outbound_gateway=.*|  <X-PRE-PROCESS cmd=\\"set\\" data=\\"default_outbound_gateway=${name}\\"/>|" /etc/freeswitch/vars.xml ` +
          `|| sed -i "/default_password=/a \\  <X-PRE-PROCESS cmd=\\"set\\" data=\\"default_outbound_gateway=${name}\\"/>" /etc/freeswitch/vars.xml` +
          `' && docker exec ${DOCKER_CONTAINER} fs_cli -p ${ESL_PW_FOR_SHIP} -x 'reloadxml'`,
      ], { timeout: 12000 });
      anyOk = true;
      logger.info({ ip, gateway: name }, '[esl] default outbound gateway set');
    } catch (err: any) {
      logger.warn({ err: err?.message ?? String(err), ip, gateway: name }, '[esl] default outbound update failed');
    }
  }
  return anyOk;
}

export function getGatewayStatus(name: string): Promise<string> {
  return new Promise((resolve) => {
    if (!eslClient.isConnected()) { resolve('unknown'); return; }
    // Parse sofia status to find gateway state
    eslClient.api(`sofia xmlstatus gateway ${name}`);
    // For now return unknown — the event listener will update status async
    resolve('checking');
  });
}
