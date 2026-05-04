import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

// Two auth paths supported. ANTHROPIC_AUTH_TOKEN (OAuth access token from
// claude.ai / Claude Code subscription) takes precedence — it ties calls to
// the Max plan rate limits and requires the oauth beta header. Falls back to
// ANTHROPIC_API_KEY (prepaid credits) when no OAuth token is set.
export function getClaude(): Anthropic {
  if (!client) {
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (authToken) {
      client = new Anthropic({
        authToken,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
      });
    } else if (apiKey) {
      client = new Anthropic({ apiKey });
    } else {
      throw new Error('Neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY set');
    }
  }
  return client;
}

const SYSTEM_PROMPT = `You are a senior backend engineer doing triage on production errors for TreePBX, a multi-tenant cloud telephony SaaS.

Stack:
- Backend: Bun + Hono + Drizzle ORM + Postgres on ctl02 (Hetzner Cloud)
- Frontend: React + Vite + TypeScript + sip.js softphone over WSS
- Telephony: FreeSWITCH (mod_sofia, ESL) + Kamailio (REGISTRAR + DISPATCHER), Hetzner Floating IPs
- Auth: JWT bearer tokens, single-use WS tickets via Redis
- Storage: MinIO (S3-compatible) for audio/recordings
- Caddy reverse proxy with same-origin /api → backend

Repo layout:
- /opt/tpbx/backend/src/routes/{platform,tenant,agent}/*.routes.ts — HTTP routes
- /opt/tpbx/backend/src/middleware/*.ts — auth, error handler, roles
- /opt/tpbx/backend/src/esl/*.ts — FreeSWITCH ESL events + dialer
- /opt/tpbx/backend/src/ws/handlers.ts — WebSocket softphone signalling
- /opt/tpbx/backend/src/db/schema/*.ts — Drizzle table definitions
- /opt/tpbx/frontend-src/src/pages/*.tsx — UI pages
- /opt/tpbx/frontend-src/src/components/* — shared components

Given an error captured from the production debugger, do exactly this:

1. **Root cause** — one or two sentences naming the actual bug.
2. **File** — the most likely file path + line area to edit.
3. **Fix** — a concrete patch (small code block) or precise change description.
4. **Verify** — one curl/SQL/log command to confirm the fix.

Be terse. Do not restate the input. No preamble. No "Let me analyze…". Skip points where you cannot make a confident claim — say "unknown" rather than guessing. If the error is benign (expected 4xx, user input, transient retry), say so and stop.`;

interface ErrorRow {
  level: string;
  source: string;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  errType: string | null;
  errMessage: string;
  stack: string | null;
  context: Record<string, unknown> | null;
  userEmail?: string | null;
  createdAt: string | Date;
}

function buildUserPrompt(err: ErrorRow): string {
  const lines: string[] = [];
  lines.push(`Level: ${err.level} (${err.source})`);
  if (err.method || err.path) lines.push(`Endpoint: ${err.method ?? '-'} ${err.path ?? '-'}`);
  if (err.statusCode != null) lines.push(`Status: ${err.statusCode}`);
  if (err.errType) lines.push(`Type: ${err.errType}`);
  lines.push('');
  lines.push('Message:');
  lines.push(err.errMessage);
  if (err.stack) {
    lines.push('');
    lines.push('Stack:');
    lines.push(err.stack.slice(0, 4000));
  }
  if (err.context && Object.keys(err.context).length) {
    lines.push('');
    lines.push('Context:');
    lines.push(JSON.stringify(err.context, null, 2).slice(0, 2000));
  }
  if (err.userEmail) {
    lines.push('');
    lines.push(`Affected user: ${err.userEmail}`);
  }
  lines.push('');
  lines.push(`Captured: ${typeof err.createdAt === 'string' ? err.createdAt : err.createdAt.toISOString()}`);
  return lines.join('\n');
}

export async function analyzeError(err: ErrorRow): Promise<{ analysis: string; usage: { input: number; output: number; cacheRead: number } }> {
  const claude = getClaude();
  const stream = claude.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(err) }],
  });

  const final = await stream.finalMessage();
  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return {
    analysis: text,
    usage: {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
    },
  };
}
