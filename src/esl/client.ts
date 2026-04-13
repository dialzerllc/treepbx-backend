import { Socket } from 'net';
import { logger } from '../lib/logger';
import { EventEmitter } from 'events';

export class ESLClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private connected = false;

  constructor(
    private host: string = '127.0.0.1',
    private port: number = 8021,
    private password: string = 'ClueCon',
  ) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();

      this.socket.connect(this.port, this.host, () => {
        logger.info({ host: this.host, port: this.port }, 'ESL TCP connected');
      });

      this.socket.on('data', (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.socket.on('close', () => {
        this.connected = false;
        logger.warn('ESL connection closed');
        this.emit('disconnected');
        // Auto-reconnect after 5s
        setTimeout(() => this.connect().catch(() => {}), 5000);
      });

      this.socket.on('error', (err) => {
        logger.error({ err }, 'ESL socket error');
        reject(err);
      });

      // Wait for auth/request
      this.once('auth/request', () => {
        this.send(`auth ${this.password}`);
      });

      this.once('command/reply', (reply: string) => {
        if (reply.includes('+OK')) {
          this.connected = true;
          logger.info('ESL authenticated');
          // Subscribe to all events
          this.send('event plain ALL');
          resolve();
        } else {
          reject(new Error('ESL auth failed'));
        }
      });
    });
  }

  private processBuffer() {
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop() ?? '';

    for (const part of parts) {
      const headers = this.parseHeaders(part);
      const contentType = headers['Content-Type'];

      if (contentType === 'auth/request') {
        this.emit('auth/request');
      } else if (contentType === 'command/reply') {
        this.emit('command/reply', headers['Reply-Text'] ?? '');
      } else if (contentType === 'text/event-plain') {
        this.emit('event', headers);
      }
    }
  }

  private parseHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim()] = decodeURIComponent(line.slice(idx + 1).trim());
      }
    }
    return headers;
  }

  send(command: string): void {
    if (!this.socket || !this.connected) {
      logger.warn({ command }, 'ESL not connected, dropping command');
      return;
    }
    this.socket.write(`${command}\n\n`);
  }

  api(command: string): void {
    this.send(`api ${command}`);
  }

  bgapi(command: string): void {
    this.send(`bgapi ${command}`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect() {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
}

// Singleton ESL client
export const eslClient = new ESLClient(
  process.env.FREESWITCH_HOST ?? '127.0.0.1',
  parseInt(process.env.FREESWITCH_ESL_PORT ?? '8021'),
  process.env.FREESWITCH_ESL_PASSWORD ?? 'ClueCon',
);
