import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Readable as NodeReadable } from 'node:stream';
import { Readable } from 'node:stream';
import path from 'node:path';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { ConnectionTCPFull } from 'telegram/network/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { PyTgCallsVoiceAssistant } from './pytgcalls-voice-assistant.js';
import { config } from '../config/env.js';
import { GroupModel } from '../models/index.js';
import { logger } from '../utils/logger.js';

interface GramTGCallsSession {
  stream(
    audio?: {
      readable?: Readable;
      listeners?: {
        onError?: (error: Error) => void;
        onFinish?: () => void;
      };
      params?: {
        bitsPerSample?: number;
        sampleRate?: number;
        channelCount?: number;
      };
    },
    video?: undefined,
    params?: {
      join?: {
        joinAs?: Api.TypeEntityLike;
        muted?: boolean;
        videoStopped?: boolean;
      };
    }
  ): Promise<void>;
  pauseAudio(): boolean | null;
  resumeAudio(): boolean | null;
  stop(): Promise<boolean>;
}

type GramTGCallsConstructor = new (
  client: TelegramClient,
  chat: Api.TypeEntityLike
) => GramTGCallsSession;

interface ActiveCallState {
  session: GramTGCallsSession;
  silence: Readable;
  playback?: PlaybackProcess;
  callKey: string;
  queue: QueuedTrack[];
  preparing: boolean;
  currentPlaybackRequestId?: string;
  paused: boolean;
  loopMode: 'off' | 'track';
}

type PlayProgressStage =
  'searching' | 'downloading' | 'downloaded' | 'startingPlayback' | 'playbackStarted';

type PlayProgressFn = (stage: PlayProgressStage) => void | Promise<void>;

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
  needsAssistant?: boolean;
}

interface QueuedTrack {
  id: string;
  query: string;
  preparedAudio: Promise<PreparedAudio>;
}

interface PreparedAudio {
  filePath: string;
  title: string;
  url?: string;
}

interface PlaybackProcess {
  id: string;
  query: string;
  title: string;
  url?: string;
  filePath: string;
  audio: Readable;
  ready: Promise<void>;
  finished: Promise<void>;
}

export interface TrackPlaybackEvent {
  chatId: number;
  queueId: string;
  query: string;
  title: string;
  url?: string;
  durationSeconds: number;
}

const PCM_FRAME_BYTES = 960;
const PCM_FRAME_INTERVAL_MS = 10;
const PCM_PUSH_FRAMES = 5;
const PCM_PUSH_INTERVAL_MS = PCM_FRAME_INTERVAL_MS * PCM_PUSH_FRAMES;
const PCM_PREBUFFER_FRAMES = 100;
const VOICE_CACHE_DIR = path.join(process.cwd(), 'outputs', 'voice-cache');

const CONNECTION_RETRIES = 10;
const RECONNECT_RETRIES = 20;
const TELEGRAM_IPV4_DCS = new Map<number, string>([
  [1, '149.154.175.53'],
  [2, '149.154.167.51'],
  [3, '149.154.175.100'],
  [4, '149.154.167.91'],
  [5, '91.108.56.130']
]);
const require = createRequire(import.meta.url);
const { GramTGCalls } = require('gram-tgcalls') as {
  GramTGCalls: GramTGCallsConstructor & {
    prototype: {
      updateHandler?: (update: unknown) => void;
    };
  };
};
const ffmpegStaticPath = require('ffmpeg-static') as string | null;

// gram-tgcalls registers this method as an unbound callback, which crashes when
// Telegram emits group-call updates. Session cleanup is handled by this service.
GramTGCalls.prototype.updateHandler = () => undefined;

export class VoiceAssistant {
  private readonly client: TelegramClient;
  private readonly activeCalls = new Map<number, ActiveCallState>();
  private connected = false;
  private readonly trackStartedListeners = new Set<(event: TrackPlaybackEvent) => void>();
  private readonly trackFinishedListeners = new Set<(event: TrackPlaybackEvent) => void>();

  public onTrackStarted(listener: (event: TrackPlaybackEvent) => void): () => void {
    this.trackStartedListeners.add(listener);
    return () => this.trackStartedListeners.delete(listener);
  }

  public onTrackFinished(listener: (event: TrackPlaybackEvent) => void): () => void {
    this.trackFinishedListeners.add(listener);
    return () => this.trackFinishedListeners.delete(listener);
  }

  public constructor() {
    const session = new StringSession(config.sessionString);
    forceSessionIpv4Dc(session);

    this.client = new TelegramClient(session, config.apiId, config.apiHash, {
      autoReconnect: true,
      connection: ConnectionTCPFull,
      connectionRetries: CONNECTION_RETRIES,
      reconnectRetries: RECONNECT_RETRIES,
      retryDelay: 2_000,
      timeout: 30,
      useIPV6: false,
      useWSS: false
    });
    this.client.onError = (error) => {
      if (formatError(error) === 'TIMEOUT') {
        return Promise.resolve();
      }

      logger.warn('Voice assistant Telegram connection error', {
        error: formatError(error)
      });
      return Promise.resolve();
    };
  }

  public async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await this.client.connect();

    if (!(await this.client.isUserAuthorized())) {
      throw new Error(
        'SESSION_STRING is not authorized. Run generate:session again for the assistant account.'
      );
    }

    const me = await this.client.getMe();
    this.connected = true;

    logger.info('Voice assistant connected', {
      assistantId: Number(me.id),
      username: me.username
    });
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    for (const [chatId, state] of this.activeCalls) {
      try {
        stopPlayback(state);
        cleanupQueuedTracks(state.queue);
        await state.session.stop();
      } catch (error) {
        logger.warn('Failed to stop active voice session during disconnect', { chatId, error });
      } finally {
        state.silence.destroy();
      }
    }

    this.activeCalls.clear();
    await this.client.disconnect();
    this.connected = false;
    logger.info('Voice assistant disconnected');
  }

  public async join(chatId: number): Promise<VoiceResult> {
    await this.connect();

    const existingState = this.activeCalls.get(chatId);

    if (existingState && !(await this.isVoiceChatStillActive(chatId, existingState))) {
      await this.resetCallState(chatId, existingState);
    } else if (existingState) {
      return {
        ok: true,
        message: 'Assistant is already connected to this voice chat.'
      };
    }

    let callKey: string | null = null;
    try {
      callKey = await this.getActiveGroupCallKey(chatId);
    } catch (error) {
      const msg = formatError(error);
      if (msg.includes('CHANNEL_INVALID') || msg.includes('PEER_ID_INVALID')) {
        return {
          ok: false,
          message: 'Assistant account is not in this group. It needs to be added.',
          needsAssistant: true
        };
      }
      return {
        ok: false,
        message: `Could not access group info: ${msg}`
      };
    }

    if (!callKey) {
      return {
        ok: false,
        message:
          'No active voice chat found. Start a group voice chat first, then send /join again.'
      };
    }

    const silence = createSilentPcmStream();
    const session = new GramTGCalls(this.client, chatId.toString());

    try {
      await session.stream(
        {
          readable: silence,
          listeners: {
            onError: (error) => {
              logger.warn('Voice assistant silence stream error', {
                chatId,
                error: formatError(error)
              });
            }
          },
          params: {
            bitsPerSample: 16,
            sampleRate: 48_000,
            channelCount: 1
          }
        },
        undefined,
        {
          join: {
            joinAs: await this.client.getInputEntity('me'),
            muted: false,
            videoStopped: true
          }
        }
      );

      this.activeCalls.set(chatId, {
        queue: [],
        session,
        silence,
        callKey,
        preparing: false,
        paused: false,
        loopMode: 'off'
      });

      await GroupModel.updateOne(
        { chatId },
        {
          $set: {
            'voiceChat.isActive': true,
            'voiceChat.lastJoinAt': new Date()
          }
        }
      );

      return {
        ok: true,
        message: 'Assistant joined the voice chat.'
      };
    } catch (error) {
      silence.destroy();
      logger.warn('Voice assistant join failed', { chatId, error });

      return {
        ok: false,
        message: `Could not join the voice chat yet: ${formatError(error)}`
      };
    }
  }

  public async leave(chatId: number): Promise<VoiceResult> {
    await this.connect();

    const state = this.activeCalls.get(chatId);

    if (!state) {
      return {
        ok: false,
        message: 'No active voice chat found to leave.'
      };
    }

    try {
      stopPlayback(state);
      cleanupQueuedTracks(state.queue);
      await state.session.stop();
      state.silence.destroy();
      this.activeCalls.delete(chatId);

      await GroupModel.updateOne(
        { chatId },
        {
          $set: {
            'voiceChat.isActive': false,
            'voiceChat.lastLeaveAt': new Date()
          }
        }
      );

      return {
        ok: true,
        message: 'Assistant left the voice chat.'
      };
    } catch (error) {
      logger.warn('Voice assistant leave failed', { chatId, error });

      return {
        ok: false,
        message: `Could not leave the voice chat cleanly: ${formatError(error)}`
      };
    }
  }

  public async play(
    chatId: number,
    query: string,
    progress?: PlayProgressFn
  ): Promise<VoiceResult> {
    await this.connect();

    const missingTool = getMissingPlaybackTool();

    if (missingTool) {
      return {
        ok: false,
        message: `${missingTool} is not installed or not on PATH. Install ${missingTool}, restart the bot, then try /play again.`
      };
    }

    await notifyPlayProgress(progress, 'searching');

    let state = this.activeCalls.get(chatId);

    if (state && !(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      state = undefined;
    }

    if (!state) {
      const joinResult = await this.join(chatId);

      if (!joinResult.ok) {
        return joinResult;
      }

      state = this.activeCalls.get(chatId);
    }

    if (!state) {
      return {
        ok: false,
        message: 'Assistant is not connected to the voice chat.'
      };
    }

    if (state.playback || state.preparing) {
      const track = createQueuedTrack(query, progress);
      state.queue.push(track);
      return {
        ok: true,
        message: `Queued and downloading: ${query}\nPosition: ${state.queue.length}`,
        status: 'queued',
        query,
        position: state.queue.length,
        queueId: state.queue.at(-1)?.id,
        ready: track.preparedAudio.then(() => undefined).catch(() => undefined)
      };
    }

    const track = createQueuedTrack(query, progress);
    return this.startPlayback(chatId, state, track, progress);
  }

  public async pause(chatId: number): Promise<VoiceResult> {
    const state = this.activeCalls.get(chatId);

    if (state && !(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      return {
        ok: false,
        message: 'Voice chat was ended. Start a new voice chat, then send /play again.'
      };
    }

    if (!state?.playback) {
      return {
        ok: false,
        message: 'Nothing is playing.'
      };
    }

    const paused = state.session.pauseAudio();

    if (!paused) {
      return {
        ok: false,
        message: 'Playback is already paused or cannot be paused right now.'
      };
    }

    state.paused = true;
    return {
      ok: true,
      message: 'Paused.'
    };
  }

  public async resume(chatId: number): Promise<VoiceResult> {
    const state = this.activeCalls.get(chatId);

    if (state && !(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      return {
        ok: false,
        message: 'Voice chat was ended. Start a new voice chat, then send /play again.'
      };
    }

    if (!state?.playback) {
      return {
        ok: false,
        message: 'Nothing is playing.'
      };
    }

    const resumed = state.session.resumeAudio();

    if (!resumed) {
      return {
        ok: false,
        message: 'Playback is already running or cannot be resumed right now.'
      };
    }

    state.paused = false;
    return {
      ok: true,
      message: 'Resumed.'
    };
  }

  public async toggleLoop(chatId: number): Promise<VoiceResult> {
    const state = this.activeCalls.get(chatId);

    if (!state) {
      return {
        ok: false,
        message: 'No active voice chat found.'
      };
    }

    state.loopMode = state.loopMode === 'track' ? 'off' : 'track';

    return {
      ok: true,
      message: state.loopMode === 'track' ? 'Looping current song.' : 'Loop off.',
      loopEnabled: state.loopMode === 'track'
    };
  }

  public async skip(chatId: number): Promise<VoiceResult> {
    const state = this.activeCalls.get(chatId);

    if (state && !(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      return {
        ok: false,
        message: 'Voice chat was ended. Playback state has been cleared.'
      };
    }

    if (!state?.playback) {
      return {
        ok: false,
        message: 'Nothing is playing.'
      };
    }

    const skipped = state.playback.query;
    state.loopMode = 'off';
    stopPlayback(state);
    void this.playNext(chatId, state);

    return {
      ok: true,
      message: `Skipped: ${skipped}`,
      loopEnabled: false
    };
  }

  public async playNow(chatId: number, queueId: string): Promise<VoiceResult> {
    const state = this.activeCalls.get(chatId);

    if (!state) {
      return { ok: false, message: 'No active voice chat found.' };
    }

    const index = state.queue.findIndex((track) => track.id === queueId);
    if (index < 0) {
      return { ok: false, message: 'That queued song is no longer available.' };
    }

    const track = state.queue.splice(index, 1)[0];
    if (!track) {
      return { ok: false, message: 'That queued song is no longer available.' };
    }

    state.loopMode = 'off';
    stopPlayback(state);
    const result = await this.startPlayback(chatId, state, track);

    if (!result.ok && result.message !== 'A newer playback request was started.') {
      state.queue.unshift(track);
    }

    return result;
  }

  public async getQueue(chatId: number): Promise<string> {
    const state = this.activeCalls.get(chatId);

    if (state && !(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      return 'Voice chat was ended. Queue cleared.';
    }

    if (!state?.playback && (!state || state.queue.length === 0)) {
      return 'Queue is empty.';
    }

    const lines = ['Queue:'];

    if (state.playback) {
      lines.push(`Now playing: ${state.playback.query}`);
    }

    state.queue.slice(0, 10).forEach((track, index) => {
      lines.push(`${index + 1}. ${track.query}`);
    });

    if (state.queue.length > 10) {
      lines.push(`...and ${state.queue.length - 10} more`);
    }

    return lines.join('\n');
  }

  public async joinGroupByInvite(inviteLink: string): Promise<VoiceResult> {
    await this.connect();

    const hash = extractInviteHash(inviteLink);

    if (!hash) {
      return {
        ok: false,
        message: 'Could not parse the group invite link.'
      };
    }

    try {
      await this.client.invoke(
        new Api.messages.ImportChatInvite({
          hash
        })
      );

      return {
        ok: true,
        message: 'Assistant account joined the group.'
      };
    } catch (error) {
      const message = formatError(error);

      if (message.includes('USER_ALREADY_PARTICIPANT')) {
        return {
          ok: true,
          message: 'Assistant account is already in this group.'
        };
      }

      logger.warn('Assistant failed to join group invite', { error: message });
      return {
        ok: false,
        message: `Assistant could not join the group: ${message}`
      };
    }
  }

  private async startPlayback(
    chatId: number,
    state: ActiveCallState,
    trackOrQuery: QueuedTrack | string,
    progress?: PlayProgressFn
  ): Promise<VoiceResult> {
    const playbackRequestId = randomUUID();
    state.currentPlaybackRequestId = playbackRequestId;
    const track =
      typeof trackOrQuery === 'string' ? createQueuedTrack(trackOrQuery, progress) : trackOrQuery;
    let playback: PlaybackProcess | undefined;

    try {
      state.preparing = true;
      playback = await createPlaybackProcess(track);
      await playback.ready;

      if (state.currentPlaybackRequestId !== playbackRequestId) {
        stopDetachedPlayback(playback);
        state.preparing = false;
        return {
          ok: false,
          message: 'A newer playback request was started.'
        };
      }

      if (!(await this.isVoiceChatStillActive(chatId, state))) {
        stopDetachedPlayback(playback);
        await this.resetCallState(chatId, state);
        return {
          ok: false,
          message:
            'Voice chat was ended before playback started. Start a new VC and send /play again.'
        };
      }

      stopPlayback(state);
      state.playback = playback;
      state.preparing = false;
      state.paused = false;

      const activePlayback = playback;

      void activePlayback.finished
        .then(() => {
          const currentState = this.activeCalls.get(chatId);
          if (currentState?.playback !== activePlayback) {
            return;
          }

          this.emitTrackFinished(chatId, activePlayback);
          state.playback = undefined;

          if (state.loopMode === 'track') {
            const loopTrack = createQueuedTrackFromPreparedAudio(
              activePlayback.query,
              {
                filePath: activePlayback.filePath,
                title: activePlayback.title,
                url: activePlayback.url
              },
              randomUUID()
            );
            void this.startPlayback(chatId, state, loopTrack);
            return;
          }

          cleanupFile(activePlayback.filePath);
          void this.playNext(chatId, state);
        })
        .catch((error: unknown) => {
          logger.warn('Playback stream finished with error', {
            chatId,
            query: track.query,
            error: formatError(error)
          });
        });

      await notifyPlayProgress(progress, 'startingPlayback');
      await state.session.stream({
        readable: playback.audio,
        listeners: {
          onError: (error) => {
            logger.warn('Voice assistant playback stream error', {
              chatId,
              query: track.query,
              error: formatError(error)
            });
          }
        },
        params: {
          bitsPerSample: 16,
          sampleRate: 48_000,
          channelCount: 1
        }
      });

      const durationSeconds = getRawAudioDurationSeconds(playback.filePath);
      this.emitTrackStarted(chatId, playback, durationSeconds);
      await notifyPlayProgress(progress, 'playbackStarted');

      return {
        ok: true,
        message: `Playing: ${track.query}`,
        status: 'playing',
        query: track.query,
        title: playback.title,
        url: playback.url,
        queueId: playback.id,
        durationSeconds
      };
    } catch (error) {
      state.preparing = false;
      if (playback) {
        stopDetachedPlayback(playback);
      }

      return {
        ok: false,
        message: `Could not start playback: ${formatError(error)}`
      };
    } finally {
      if (state.currentPlaybackRequestId === playbackRequestId) {
        state.currentPlaybackRequestId = undefined;
      }
    }
  }

  private emitTrackStarted(
    chatId: number,
    playback: PlaybackProcess,
    durationSeconds: number
  ): void {
    const event = {
      chatId,
      queueId: playback.id,
      query: playback.query,
      title: playback.title,
      url: playback.url,
      durationSeconds
    };
    this.trackStartedListeners.forEach((listener) => listener(event));
  }

  private emitTrackFinished(chatId: number, playback: PlaybackProcess): void {
    const event = {
      chatId,
      queueId: playback.id,
      query: playback.query,
      title: playback.title,
      url: playback.url,
      durationSeconds: getRawAudioDurationSeconds(playback.filePath)
    };
    this.trackFinishedListeners.forEach((listener) => listener(event));
  }

  private async playNext(chatId: number, state: ActiveCallState): Promise<void> {
    if (!(await this.isVoiceChatStillActive(chatId, state))) {
      await this.resetCallState(chatId, state);
      return;
    }

    const next = state.queue.shift();

    if (!next) {
      await this.leave(chatId);
      return;
    }

    const result = await this.startPlayback(chatId, state, next);

    if (!result.ok) {
      logger.warn('Queued playback failed', { chatId, query: next.query, message: result.message });
      await this.playNext(chatId, state);
    }
  }

  private async hasActiveGroupCall(chatId: number): Promise<boolean> {
    return Boolean(await this.getActiveGroupCallKey(chatId));
  }

  private async isVoiceChatStillActive(chatId: number, state: ActiveCallState): Promise<boolean> {
    try {
      const currentCallKey = await this.getActiveGroupCallKey(chatId);
      return currentCallKey === state.callKey;
    } catch (error) {
      logger.warn('Could not verify voice chat state', { chatId, error: formatError(error) });
      return false;
    }
  }

  private async getActiveGroupCallKey(chatId: number): Promise<string | null> {
    const fullChat = await this.getFullChat(chatId);
    const call = fullChat.call;

    if (!call) {
      return null;
    }

    return formatGroupCallKey(call);
  }

  private async resetCallState(chatId: number, state: ActiveCallState): Promise<void> {
    stopPlayback(state);
    cleanupQueuedTracks(state.queue);
    state.silence.destroy();
    this.activeCalls.delete(chatId);

    try {
      await state.session.stop();
    } catch (error) {
      logger.warn('Failed to stop stale voice session', { chatId, error: formatError(error) });
    }

    await GroupModel.updateOne(
      { chatId },
      {
        $set: {
          'voiceChat.isActive': false,
          'voiceChat.lastLeaveAt': new Date()
        }
      }
    );
  }

  private async getFullChat(chatId: number): Promise<Api.TypeChatFull> {
    try {
      if (isSupergroupId(chatId)) {
        const entity = await this.client.getInputEntity(chatId.toString());
        const result = await this.client.invoke(
          new Api.channels.GetFullChannel({
            channel: entity
          })
        );

        return result.fullChat;
      }

      const result = await this.client.invoke(
        new Api.messages.GetFullChat({
          chatId: bigInt(Math.abs(chatId))
        })
      );

      return result.fullChat;
    } catch (error) {
      logger.warn('Failed to get full chat', { chatId, error: formatError(error) });
      throw error;
    }
  }
}

export const voiceAssistant =
  config.voiceEngine === 'pytgcalls' ? new PyTgCallsVoiceAssistant() : new VoiceAssistant();

function createSilentPcmStream(): Readable {
  const stream = new Readable({
    read() {
      // Data is pushed on a timer to approximate real-time 20 ms PCM frames.
    }
  });
  const frame = Buffer.alloc(PCM_FRAME_BYTES);
  const interval = setInterval(() => {
    if (stream.destroyed) {
      clearInterval(interval);
      return;
    }

    stream.push(frame);
  }, PCM_FRAME_INTERVAL_MS);

  stream.once('close', () => clearInterval(interval));
  stream.once('end', () => clearInterval(interval));

  return stream;
}

function createQueuedTrack(query: string, progress?: PlayProgressFn): QueuedTrack {
  const preparedAudio = (async () => {
    await notifyPlayProgress(progress, 'downloading');
    const audio = await prepareAudioFile(query);
    await notifyPlayProgress(progress, 'downloaded');
    return audio;
  })();

  preparedAudio.catch((error: unknown) => {
    logger.warn('Queued audio download failed', { query, error: formatError(error) });
  });

  return {
    id: randomUUID(),
    query,
    preparedAudio
  };
}

function createQueuedTrackFromPreparedAudio(
  query: string,
  preparedAudio: PreparedAudio,
  id: string = randomUUID()
): QueuedTrack {
  return {
    id,
    query,
    preparedAudio: Promise.resolve(preparedAudio)
  };
}

async function createPlaybackProcess(track: QueuedTrack): Promise<PlaybackProcess> {
  const preparedAudio = await track.preparedAudio;
  const { filePath, title, url } = preparedAudio;
  const source = createReadStream(filePath);
  const { finished, ready, stream: audio } = createPacedPcmStream(source);

  return { id: track.id, query: track.query, title, url, filePath, audio, ready, finished };
}

async function prepareAudioFile(query: string): Promise<PreparedAudio> {
  mkdirSync(VOICE_CACHE_DIR, { recursive: true });

  const source = isHttpUrl(query) ? query : `ytsearch1:${query}`;
  const COMMON_ARGS = [
    '--no-playlist',
    '--force-ipv4',

    '--js-runtimes',
    'node',

    '--print',
    'after_move:%(title)s\\t%(webpage_url)s'
  ];

  const attempts = [
    {
      label: 'web-m4a',
      args: [
        ...COMMON_ARGS,
        '--extractor-args',
        'youtube:player_client=web',
        '-f',
        '140/251/250/249/bestaudio',
        '-o'
      ]
    },
    {
      label: 'web-bestaudio',
      args: [
        ...COMMON_ARGS,
        '--extractor-args',
        'youtube:player_client=web',
        '-f',
        'bestaudio',
        '-o'
      ]
    },
    {
      label: 'best',
      args: [...COMMON_ARGS, '--extractor-args', 'youtube:player_client=web', '-f', 'best', '-o']
    },
    {
      label: 'no-format',
      args: [...COMMON_ARGS, '--extractor-args', 'youtube:player_client=web', '-o']
    }
  ];

  let lastError: unknown;

  for (const attempt of attempts) {
    const workDir = mkdtempSync(path.join(VOICE_CACHE_DIR, 'track-'));
    const outputTemplate = path.join(workDir, 'source.%(ext)s');

    try {
      const ytDlpArgs = [...attempt.args, outputTemplate];

      // Add cookies if configured
      if (config.ytDlpCookies) {
        // Check if it's a file path (contains / or \) or a browser name
        if (config.ytDlpCookies.includes('/') || config.ytDlpCookies.includes('\\')) {
          ytDlpArgs.splice(1, 0, '--cookies', config.ytDlpCookies);
        } else {
          ytDlpArgs.splice(1, 0, '--cookies-from-browser', config.ytDlpCookies);
        }
      }

      // Add additional fallback strategies to avoid bot detection
      ytDlpArgs.push(
        '--user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      );
      ytDlpArgs.push(source);
      logger.info({
        strategy: attempt.label,
        command: resolveYtDlpPath(),
        args: ytDlpArgs.join(' ')
      });
      const metadataOutput = await runProcess(resolveYtDlpPath(), ytDlpArgs);

      const downloaded = readdirSync(workDir)
        .map((file) => path.join(workDir, file))
        .find((file) => path.basename(file).startsWith('source.'));

      if (!downloaded) {
        throw new Error(`yt-dlp did not produce an audio file (${attempt.label}).`);
      }

      const rawPath = path.join(VOICE_CACHE_DIR, `${randomUUID()}.raw`);
      await runProcess(resolveFfmpegPath(), [
        '-y',
        '-hide_banner',
        '-loglevel',
        'warning',
        '-i',
        downloaded,
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '1',
        rawPath
      ]);

      const metadata = parseTrackMetadata(metadataOutput, query);
      return { filePath: rawPath, ...metadata };
    } catch (error) {
      lastError = error;
      logger.warn('yt-dlp playback attempt failed', {
        query,
        strategy: attempt.label,
        error: formatError(error)
      });
    } finally {
      rmSync(workDir, { force: true, recursive: true });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => {
      stdout.push(data);
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr.push(data);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString());
        return;
      }

      reject(new Error(Buffer.concat(stderr).toString().trim() || `${command} exited ${code}`));
    });
  });
}

function parseTrackMetadata(
  output: string,
  fallbackTitle: string
): Pick<PreparedAudio, 'title' | 'url'> {
  const metadataLine = output
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.includes('\t'));

  if (!metadataLine) {
    return { title: fallbackTitle, url: isHttpUrl(fallbackTitle) ? fallbackTitle : undefined };
  }

  const [title, url] = metadataLine.split('\t', 2);
  return { title: title ?? fallbackTitle, url: url && isHttpUrl(url) ? url : undefined };
}

function cleanupFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Cache cleanup should not interrupt playback control.
  }
}

function cleanupQueuedTracks(queue: QueuedTrack[]): void {
  for (const track of queue) {
    track.preparedAudio.then(({ filePath }) => cleanupFile(filePath)).catch(() => undefined);
  }

  queue.length = 0;
}

async function notifyPlayProgress(
  progress: PlayProgressFn | undefined,
  stage: PlayProgressStage
): Promise<void> {
  if (!progress) {
    return;
  }

  try {
    await progress(stage);
  } catch (error) {
    logger.warn('Playback progress callback failed', { stage, error: formatError(error) });
  }
}

function getRawAudioDurationSeconds(filePath: string): number {
  const bytesPerSecond = 48_000 * 2;
  return Math.max(1, Math.round(statSync(filePath).size / bytesPerSecond));
}

function stopPlayback(state: ActiveCallState): void {
  if (!state.playback) {
    return;
  }

  cleanupFile(state.playback.filePath);
  state.playback.audio.destroy();
  state.playback = undefined;
}

function stopDetachedPlayback(playback: PlaybackProcess): void {
  cleanupFile(playback.filePath);
  playback.audio.destroy();
}

function createPacedPcmStream(source: NodeReadable): {
  stream: Readable;
  ready: Promise<void>;
  finished: Promise<void>;
} {
  let cache = Buffer.alloc(0);
  let sourceEnded = false;
  let started = false;
  let readySettled = false;
  let finishedSettled = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let resolveFinished: () => void;
  let rejectFinished: (error: Error) => void;

  const stream = new Readable({
    read() {
      // Data is emitted by the interval below to keep WebRTC pacing stable.
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  source.on('data', (chunk: Buffer) => {
    cache = Buffer.concat([cache, chunk]);
  });
  source.once('end', () => {
    sourceEnded = true;
  });
  source.once('error', (error) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }

    if (!finishedSettled) {
      finishedSettled = true;
      rejectFinished(error);
    }

    stream.destroy(error);
  });

  const interval = setInterval(() => {
    if (stream.destroyed) {
      clearInterval(interval);
      return;
    }

    if (!started) {
      started = cache.length >= PCM_FRAME_BYTES * PCM_PREBUFFER_FRAMES || sourceEnded;

      if (started && cache.length === 0 && sourceEnded) {
        const error = new Error('Audio source ended before producing PCM data.');
        readySettled = true;
        finishedSettled = true;
        rejectReady(error);
        rejectFinished(error);
        stream.destroy(error);
        clearInterval(interval);
        return;
      }

      if (started && !readySettled) {
        readySettled = true;
        resolveReady();
      }
    }

    if (!started) {
      return;
    }

    const chunkBytes = PCM_FRAME_BYTES * PCM_PUSH_FRAMES;

    if (cache.length >= chunkBytes) {
      stream.push(cache.subarray(0, chunkBytes));
      cache = cache.subarray(chunkBytes);
      return;
    }

    if (sourceEnded) {
      if (cache.length > 0) {
        stream.push(cache);
        cache = Buffer.alloc(0);
        return;
      }

      if (!finishedSettled) {
        finishedSettled = true;
        resolveFinished();
      }

      clearInterval(interval);
      return;
    }

    stream.push(Buffer.alloc(chunkBytes));
  }, PCM_PUSH_INTERVAL_MS);

  stream.once('close', () => clearInterval(interval));

  return { stream, ready, finished };
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function formatGroupCallKey(call: Api.TypeInputGroupCall): string {
  const id = 'id' in call ? String(call.id) : 'unknown';
  const accessHash = 'accessHash' in call ? String(call.accessHash) : 'unknown';
  return `${id}:${accessHash}`;
}

function extractInviteHash(inviteLink: string): string | null {
  const plusMatch = /t\.me\/\+([^/?#]+)/.exec(inviteLink);

  if (plusMatch?.[1]) {
    return plusMatch[1];
  }

  const joinChatMatch = /t\.me\/joinchat\/([^/?#]+)/.exec(inviteLink);

  if (joinChatMatch?.[1]) {
    return joinChatMatch[1];
  }

  return null;
}

function getMissingPlaybackTool(): string | null {
  const ytDlpPath = resolveYtDlpPath();
  const ffmpegPath = resolveFfmpegPath();

  if (!canRun(ytDlpPath, ['--version'])) {
    return `yt-dlp (${ytDlpPath})`;
  }

  if (!canRun(ffmpegPath, ['-version'])) {
    return `ffmpeg (${ffmpegPath})`;
  }

  return null;
}

function resolveYtDlpPath(): string {
  if (config.ytDlpPath) {
    return config.ytDlpPath;
  }

  const appDataYtDlpPath = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Python', 'Python314', 'Scripts', 'yt-dlp.exe')
    : null;

  if (appDataYtDlpPath && existsSync(appDataYtDlpPath)) {
    return appDataYtDlpPath;
  }

  return 'yt-dlp';
}

function resolveFfmpegPath(): string {
  return config.ffmpegPath ?? ffmpegStaticPath ?? 'ffmpeg';
}

function canRun(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: 'ignore'
  });

  return result.status === 0;
}

function isSupergroupId(chatId: number): boolean {
  return chatId.toString().startsWith('-100');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function forceSessionIpv4Dc(session: StringSession): void {
  const ipv4Address = TELEGRAM_IPV4_DCS.get(session.dcId);

  if (!ipv4Address) {
    throw new Error(
      `SESSION_STRING has invalid Telegram DC ${session.dcId}. Regenerate it with npm run generate:session or scripts/generate-session.ts.`
    );
  }

  session.setDC(session.dcId, ipv4Address, 443);
}
