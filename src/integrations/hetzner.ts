import { logger } from '../lib/logger';

const HETZNER_TOKEN = process.env.HETZNER_API_TOKEN ?? '';
const BASE = 'https://api.hetzner.cloud/v1';

async function hetznerFetch(path: string, options?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${HETZNER_TOKEN}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hetzner API error ${response.status}: ${body}`);
  }
  return response.json();
}

export async function listServers() {
  return hetznerFetch('/servers');
}

/**
 * Returns Hetzner's server-type catalog. Each entry has { id, name }; we use
 * this to map the numeric IDs in `datacenters[].server_types.available` back
 * to slugs like 'ccx23' that the rest of the codebase uses.
 */
export async function listServerTypes(): Promise<{ server_types: Array<{ id: number; name: string }> }> {
  return hetznerFetch('/server_types?per_page=50');
}

/**
 * Returns datacenters with stock info under `server_types.available[]` (numeric
 * IDs of types currently orderable in that DC) and `supported[]` (anything ever
 * available there). Used for stock-aware fallback decisions.
 */
export async function listDatacenters(): Promise<{
  datacenters: Array<{
    id: number;
    name: string;            // e.g. 'fsn1-dc14'
    location: { id: number; name: string };  // e.g. { name: 'fsn1' }
    server_types: { supported: number[]; available: number[]; available_for_migration: number[] };
  }>;
}> {
  return hetznerFetch('/datacenters');
}

export async function createServer(name: string, serverType: string, location: string, userData?: string) {
  return hetznerFetch('/servers', {
    method: 'POST',
    body: JSON.stringify({
      name,
      server_type: serverType,
      location,
      image: 'ubuntu-22.04',
      user_data: userData,
      start_after_create: true,
    }),
  });
}

export async function deleteServer(serverId: number) {
  return hetznerFetch(`/servers/${serverId}`, { method: 'DELETE' });
}

export async function getServerMetrics(serverId: number, type: string, start: string, end: string) {
  return hetznerFetch(`/servers/${serverId}/metrics?type=${type}&start=${start}&end=${end}`);
}
