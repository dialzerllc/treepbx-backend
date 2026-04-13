const PIPER_URL = process.env.PIPER_URL ?? 'http://localhost:5000';

export async function synthesize(text: string, voice = 'en_US-lessac-medium') {
  const response = await fetch(`${PIPER_URL}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });

  if (!response.ok) throw new Error(`Piper error: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
