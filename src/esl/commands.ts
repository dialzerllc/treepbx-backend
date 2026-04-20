import { eslClient } from './client';
import { db } from '../db/client';
import { carriers } from '../db/schema';
import { eq, and, inArray, asc } from 'drizzle-orm';

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

export function addGateway(rawName: string, opts: {
  host: string;
  port?: number;
  transport?: string;
  username?: string;
  password?: string;
  register?: boolean;
  expiry?: number;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!eslClient.isConnected()) { resolve(false); return; }

    // Sanitize: FS gateway names can't have spaces
    const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const profile = 'external';
    const xml = `<gateway name="${name}">
  <param name="realm" value="${opts.host}"/>
  <param name="proxy" value="${opts.host}:${opts.port || 5060}"/>
  <param name="register" value="${opts.register !== false ? 'true' : 'false'}"/>
  ${opts.username ? `<param name="username" value="${opts.username}"/>` : ''}
  ${opts.password ? `<param name="password" value="${opts.password}"/>` : ''}
  <param name="expire-seconds" value="${opts.expiry || 3600}"/>
  <param name="register-transport" value="${(opts.transport || 'UDP').toLowerCase()}"/>
  <param name="retry-seconds" value="30"/>
  <param name="caller-id-in-from" value="true"/>
</gateway>`;

    // Write gateway XML via sofia profile rescan
    eslClient.api(`sofia profile ${profile} killgw ${name}`);
    // Use sofia_gateway_data to add dynamically
    eslClient.api(`sofia xmlstatus gateway ${name}`);

    // For dynamic gateway, use bgapi with sofia_contact
    // The proper way: write XML to disk and rescan
    const { writeFileSync } = require('fs');
    const gwPath = `/tmp/fs_gateway_${name}.xml`;
    try {
      writeFileSync(gwPath, `<include>${xml}</include>`);
    } catch {}

    // Copy to FreeSWITCH container and rescan
    const { execSync } = require('child_process');
    try {
      execSync(`docker cp ${gwPath} treepbx-freeswitch:/etc/freeswitch/sip_profiles/external/${name}.xml`, { timeout: 5000 });
      eslClient.api(`sofia profile external rescan`);
      resolve(true);
    } catch (err) {
      resolve(false);
    }
  });
}

export function removeGateway(name: string) {
  eslClient.api(`sofia profile external killgw ${name}`);
  // Remove config file
  try {
    const { execSync } = require('child_process');
    execSync(`docker exec treepbx-freeswitch rm -f /etc/freeswitch/sip_profiles/external/${name}.xml`, { timeout: 5000 });
  } catch {}
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
