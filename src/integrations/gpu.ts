import { env } from '../env';
import { logger } from '../lib/logger';

/**
 * GPU server integration — STT (Whisper), TTS (Piper), and LLM verdict (Ollama).
 *
 * The GPU box (gpu01, 88.198.23.72) hosts three Docker services reachable only
 * from ctl02 via firewall ACL. All endpoints here use plain HTTP — there's no
 * TLS on the loopback link, but the network path is private (DOCKER-USER chain
 * blocks any source other than ctl02's public IP).
 *
 * Each function throws on missing config or upstream error so callers can map
 * failures into per-call audit rows instead of silently bridging anyway.
 */

class GpuUnavailable extends Error {
  constructor(msg: string) { super(msg); this.name = 'GpuUnavailable'; }
}

function reqUrl(name: 'STT' | 'TTS' | 'LLM'): string {
  const url = name === 'STT' ? env.GPU_STT_URL : name === 'TTS' ? env.GPU_TTS_URL : env.GPU_LLM_URL;
  if (!url) throw new GpuUnavailable(`GPU_${name}_URL not configured`);
  return url.replace(/\/$/, '');
}

/**
 * synthesizeTts — render text to a WAV buffer via Piper.
 *
 * Used by the campaign save hook to pre-render probe prompts (one shot, cached
 * in R2) so we never pay TTS latency on a live call.
 */
export async function synthesizeTts(text: string, voice = 'default'): Promise<Buffer> {
  const url = reqUrl('TTS');
  const res = await fetch(`${url}/tts/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS synthesize failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * transcribeBuffer — send raw audio bytes to Whisper for transcription.
 *
 * The audio is uploaded as multipart/form-data with field name 'file', matching
 * the existing service's POST /stt/transcribe-file contract. Returns the
 * transcript text plus duration so callers can log timing in the audit table.
 */
export async function transcribeBuffer(audio: Buffer, filename = 'probe.wav'): Promise<{ text: string; duration?: number }> {
  const url = reqUrl('STT');
  const blob = new Blob([new Uint8Array(audio)], { type: 'audio/wav' });
  const form = new FormData();
  form.append('file', blob, filename);
  const res = await fetch(`${url}/stt/transcribe-file`, { method: 'POST', body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`STT transcribe failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json() as { text?: string; duration?: number };
  return { text: (json.text ?? '').trim(), duration: json.duration };
}

/**
 * evalProbe — ask the LLM whether the called party's response is consistent
 * with what a real human would say to our probe prompt. Returns a verdict
 * object the dialer (and audit log) can store verbatim.
 *
 * The LLM is steered toward strict JSON output via a system prompt; we then
 * parse it loosely to tolerate minor formatting drift. If parsing fails, the
 * default is to TREAT AS HUMAN (safer — never drop a real call due to LLM
 * weirdness; the worst-case is bridging to an agent and them realizing it's
 * a recording, which is recoverable).
 */
export async function evalProbe(args: {
  systemPrompt: string;
  probeText: string;
  responseTranscript: string;
}): Promise<{ isHuman: boolean; reason: string; raw: string }> {
  const url = reqUrl('LLM');
  const userMsg = `Probe prompt I just played: ${args.probeText}\nResponse from the called party: ${args.responseTranscript || '(silence — no response captured)'}`;
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.GPU_LLM_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: userMsg },
      ],
      options: { temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM eval failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json() as { message?: { content?: string } };
  const content = json.message?.content?.trim() ?? '';
  // Best-effort JSON extraction: model is asked to return {"is_human": ..., "reason": ...}
  // but may wrap in markdown or add prose.
  let parsed: { is_human?: unknown; reason?: unknown } | null = null;
  const jsonMatch = content.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
  }
  const isHuman = parsed?.is_human === true || parsed?.is_human === 'true';
  const reason = typeof parsed?.reason === 'string' ? parsed.reason : content.slice(0, 240);
  if (!parsed) {
    logger.warn({ content: content.slice(0, 240) }, '[gpu] LLM verdict not parseable as JSON — defaulting to is_human=true');
    return { isHuman: true, reason: 'verdict_unparseable_default_human', raw: content };
  }
  return { isHuman, reason, raw: content };
}

export const DEFAULT_AI_SCREEN_EVAL_PROMPT = `You are an answering-machine and recording detector for an outbound call campaign.
Given the prompt the agent played and the transcript of the called party's reply,
decide whether the reply sounds like a real human responding in real time
(yes — bridge to agent) or a pre-recorded greeting/voicemail/scripted bot
(no — drop the call).

Reply with ONLY a single JSON object on one line:
{"is_human": true | false, "reason": "<brief 1-sentence justification>"}

Treat ambiguous cases as is_human=true. Real human responses include direct answers
("yes", "this is John"), questions ("who's calling?"), or hesitation ("hello?
hello? sorry can you hear me?"). Recordings often say things unrelated to the
prompt ("we can't come to the phone right now", "leave a message after the beep")
or repeat the same scripted opener regardless of what was asked.`;
