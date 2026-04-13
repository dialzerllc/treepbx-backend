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
