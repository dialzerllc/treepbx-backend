const PIPER_URL = process.env.PIPER_URL ?? 'http://localhost:5000';

// Friendly voice IDs from the UI → Piper voice model names.
const VOICE_MAP: Record<string, string> = {
  'en-US-female': 'en_US-lessac-medium',
  'en-US-male': 'en_US-ryan-medium',
  'en-GB-female': 'en_GB-jenny_dioco-medium',
  'en-GB-male': 'en_GB-alan-medium',
  'es-ES-female': 'es_ES-davefx-medium',
  'fr-FR-female': 'fr_FR-siwis-medium',
  'de-DE-female': 'de_DE-thorsten-medium',
  'hi-IN-female': 'hi_IN-priyamvada-medium',
  'ar-SA-male': 'ar_JO-kareem-medium',
};

export function resolveVoice(voice: string | null | undefined): string {
  if (!voice) return 'en_US-lessac-medium';
  return VOICE_MAP[voice] ?? voice;
}

export async function synthesize(text: string, voice = 'en_US-lessac-medium') {
  const response = await fetch(`${PIPER_URL}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: resolveVoice(voice) }),
  });

  if (!response.ok) throw new Error(`Piper error: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
