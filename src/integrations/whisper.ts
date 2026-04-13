import { logger } from '../lib/logger';

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://localhost:8080';

export async function transcribe(audioUrl: string, language = 'en') {
  const response = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: audioUrl, language, response_format: 'json' }),
  });

  if (!response.ok) throw new Error(`Whisper error: ${response.status}`);
  const result = await response.json() as { text: string; segments?: { start: number; end: number; text: string }[] };
  return result;
}
