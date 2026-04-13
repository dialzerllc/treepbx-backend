const RUNPOD_KEY = process.env.RUNPOD_API_KEY ?? '';
const BASE = 'https://api.runpod.io/v2';

async function runpodFetch(path: string, options?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${RUNPOD_KEY}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!response.ok) throw new Error(`RunPod API error: ${response.status}`);
  return response.json();
}

export async function listPods() {
  return runpodFetch('/pods');
}

export async function createPod(name: string, gpuType: string, image: string) {
  return runpodFetch('/pods', {
    method: 'POST',
    body: JSON.stringify({ name, gpuTypeId: gpuType, imageName: image, gpuCount: 1 }),
  });
}

export async function stopPod(podId: string) {
  return runpodFetch(`/pods/${podId}/stop`, { method: 'POST' });
}

export async function deletePod(podId: string) {
  return runpodFetch(`/pods/${podId}`, { method: 'DELETE' });
}
