import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

interface VoiceResult {
  ok: boolean;
  message: string;
  status?: 'playing' | 'queued' | 'error' | 'info';
  query?: string;
  position?: number;
  durationSeconds?: number;
  queueId?: string;
  title?: string;
  url?: string;
  ready?: Promise<void>;
  loopEnabled?: boolean;
}

interface TrackPlaybackEvent {
  chatId: number;
  queueId: string;
  query: string;
  title: string;
  url?: string;
  durationSeconds: number;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  message?: string;
  queue?: string;
}

interface PendingRequest {
  resolve: (value: VoiceResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 120_000;

export class PyTgCallsVoiceAssistant {
  private process?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private connected = false;

  // The Python engine does not yet emit track lifecycle events. Keep the same
  // public shape as the native engine so the bot UI can run with either engine.
  public onTrackStarted(listener: (event: TrackPlaybackEvent) => void): () => void {
    void listener;
    return () => undefined;
  }

  public onTrackFinished(listener: (event: TrackPlaybackEvent) => void): () => void {
    void listener;
    return () => undefined;
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!config.pyrogramSessionString) {
      throw new Error(
        'PYROGRAM_SESSION_STRING is required when VOICE_ENGINE=pytgcalls. Generate a Pyrogram session for the assistant account.'
      );
    }

    this.startWorker();
    const result = await this.send('connect');

    if (!result.ok) {
      throw new Error(result.message);
    }

    this.connected = true;
    logger.info('PyTgCalls voice worker connected');
  }

  public async disconnect(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      await this.send('disconnect');
    } catch (error) {
      logger.warn('PyTgCalls voice worker disconnect failed', { error: formatError(error) });
    }

    this.stopWorker();
    this.connected = false;
    logger.info('PyTgCalls voice worker stopped');
  }

  public async join(chatId: number): Promise<VoiceResult> {
    await this.connect();
    return this.send('join', { chatId });
  }

  public async leave(chatId: number): Promise<VoiceResult> {
    await this.connect();
    return this.send('leave', { chatId });
  }

  public async play(chatId: number, query: string, progress?: unknown): Promise<VoiceResult> {
    await this.connect();
    void progress;
    return this.send('play', { chatId, query });
  }

  public async pause(chatId: number): Promise<VoiceResult> {
    await this.connect();
    return this.send('pause', { chatId });
  }

  public playNow(chatId: number, queueId: string): Promise<VoiceResult> {
    void chatId;
    void queueId;
    return Promise.resolve({
      ok: false,
      message: 'Play Now is available when VOICE_ENGINE is set to gram-tgcalls.'
    });
  }

  public async resume(chatId: number): Promise<VoiceResult> {
    await this.connect();
    return this.send('resume', { chatId });
  }

  public async toggleLoop(chatId: number): Promise<VoiceResult> {
    void chatId;
    return {
      ok: false,
      message: 'Loop mode is available when VOICE_ENGINE is set to gram-tgcalls.'
    };
  }

  public async skip(chatId: number): Promise<VoiceResult> {
    await this.connect();
    return this.send('skip', { chatId });
  }

  public async getQueue(chatId: number): Promise<string> {
    await this.connect();
    const result = await this.send('queue', { chatId });
    return result.message;
  }

  public async joinGroupByInvite(inviteLink: string): Promise<VoiceResult> {
    await this.connect();
    return this.send('join_invite', { inviteLink });
  }

  private startWorker(): void {
    if (this.process) {
      return;
    }

    const args = splitArgs(config.pythonVoiceArgs);
    const child = spawn(config.pythonVoiceBin, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_ID: String(config.apiId),
        API_HASH: config.apiHash,
        PYROGRAM_SESSION_STRING: config.pyrogramSessionString ?? '',
        YT_DLP_PATH: config.ytDlpPath ?? 'yt-dlp',
        FFMPEG_PATH: config.ffmpegPath ?? 'ffmpeg'
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      logger.info('PyTgCalls worker output', { output: data.toString().trim() });
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') {
        logger.warn('PyTgCalls worker pipe closed');
        return;
      }

      logger.warn('PyTgCalls worker stdin error', { error: formatError(error) });
    });

    child.on('exit', (code, signal) => {
      logger.warn('PyTgCalls worker exited', { code, signal });
      this.process = undefined;
      this.connected = false;
      this.rejectPending(new Error(`PyTgCalls worker exited with code ${code ?? signal}`));
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleWorkerLine(line));

    this.process = child;
  }

  private stopWorker(): void {
    if (!this.process) {
      return;
    }

    this.process.kill('SIGTERM');
    this.process = undefined;
    this.rejectPending(new Error('PyTgCalls worker stopped'));
  }

  private send(type: string, payload: Record<string, unknown> = {}): Promise<VoiceResult> {
    if (!this.process?.stdin.writable) {
      return Promise.resolve({
        ok: false,
        message: 'PyTgCalls worker is not running.'
      });
    }

    const id = this.nextId++;
    const request = JSON.stringify({ id, type, ...payload });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PyTgCalls worker request timed out: ${type}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      this.process?.stdin.write(`${request}\n`);
    });
  }

  private handleWorkerLine(line: string): void {
    let response: WorkerResponse;

    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      logger.info('PyTgCalls worker log', { output: line });
      return;
    }

    const pending = this.pending.get(response.id);

    if (!pending) {
      logger.info('PyTgCalls worker event', response);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve({
      ok: response.ok,
      message: response.message ?? response.queue ?? ''
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
