import type { ServerWebSocket } from 'bun';
import { Client as SshClient, type ClientChannel } from 'ssh2';
import { readFile } from 'fs/promises';
import { logger } from '../lib/logger';

export interface TerminalWsData {
  kind: 'terminal';
  userId: string;
  errorContext: string | null;
  ssh?: SshClient;
  stream?: ClientChannel;
}

const DEV01_HOST = process.env.DEV01_HOST ?? '87.99.129.252';
const DEV01_USER = process.env.DEV01_USER ?? 'tpbx';
const DEV01_KEY = process.env.DEV01_TERMINAL_KEY_PATH ?? '/opt/tpbx/secrets/dev01_terminal_key';

// Spawn an interactive claude session inside the dev01 backend source. Edits
// auto-approve (acceptEdits mode) but bash still pauses for the admin — so
// claude can patch code freely, but git push / deploy / dangerous shell ops
// still require explicit human approval.
const SHELL_CMD = 'cd /tmp/tb-be && exec bash -lc "claude --permission-mode acceptEdits"';

export async function terminalOpen(ws: ServerWebSocket<TerminalWsData>): Promise<void> {
  const { userId, errorContext } = ws.data;
  logger.info({ userId }, '[terminal] opening session');

  let privateKey: Buffer;
  try {
    privateKey = await readFile(DEV01_KEY);
  } catch (err: any) {
    logger.warn({ userId, err: err.message }, '[terminal] key not readable');
    ws.close(1011, 'key missing');
    return;
  }

  const ssh = new SshClient();
  ws.data.ssh = ssh;

  ssh.on('ready', () => {
    ssh.exec(SHELL_CMD, { pty: { cols: 100, rows: 30 } }, (err, stream) => {
      if (err) {
        logger.warn({ userId, err: err.message }, '[terminal] exec failed');
        ws.close(1011, 'exec failed');
        return;
      }
      ws.data.stream = stream;

      // Pipe SSH PTY → WS as binary frames
      stream.on('data', (data: Buffer) => {
        try { ws.send(data); } catch { /* ws closed */ }
      });
      stream.stderr.on('data', (data: Buffer) => {
        try { ws.send(data); } catch { /* ws closed */ }
      });

      stream.on('close', () => {
        logger.info({ userId }, '[terminal] stream closed');
        try { ws.close(1000, 'shell exited'); } catch { /* already closed */ }
        ssh.end();
      });

      // Pre-fill the bug context after claude initializes. Send 1.5s after
      // session opens so claude's TUI has time to render before the prompt
      // text starts streaming in.
      if (errorContext && errorContext.trim()) {
        setTimeout(() => {
          if (ws.data.stream) ws.data.stream.write(errorContext);
        }, 1500);
      }
    });
  });

  ssh.on('error', (err) => {
    logger.warn({ userId, err: err.message }, '[terminal] ssh error');
    try { ws.close(1011, 'ssh error'); } catch { /* */ }
  });

  ssh.connect({
    host: DEV01_HOST,
    port: 22,
    username: DEV01_USER,
    privateKey,
    readyTimeout: 10_000,
    keepaliveInterval: 30_000,
  });
}

export function terminalMessage(ws: ServerWebSocket<TerminalWsData>, raw: string | Buffer): void {
  // Two message kinds:
  //  - JSON {type:"resize",cols,rows}  → resize PTY
  //  - anything else (text or binary)  → forward as keystrokes to PTY
  if (typeof raw === 'string' && raw.startsWith('{')) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize' && ws.data.stream) {
        ws.data.stream.setWindow(msg.rows ?? 30, msg.cols ?? 100, 0, 0);
        return;
      }
    } catch { /* not JSON, fall through to write */ }
  }
  if (ws.data.stream) {
    ws.data.stream.write(raw);
  }
}

export function terminalClose(ws: ServerWebSocket<TerminalWsData>): void {
  logger.info({ userId: ws.data.userId }, '[terminal] WS closed, cleaning up');
  try { ws.data.stream?.end(); } catch { /* */ }
  try { ws.data.ssh?.end(); } catch { /* */ }
}
