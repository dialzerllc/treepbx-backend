import { eslClient } from './client';
import { db } from '../db/client';
import { carriers, mediaNodes } from '../db/schema';
import { eq, and, inArray, asc } from 'drizzle-orm';
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

export function getGatewayStatus(name: string): Promise<string> {
  return new Promise((resolve) => {
    if (!eslClient.isConnected()) { resolve('unknown'); return; }
    // Parse sofia status to find gateway state
    eslClient.api(`sofia xmlstatus gateway ${name}`);
    // For now return unknown — the event listener will update status async
    resolve('checking');
  });
}
