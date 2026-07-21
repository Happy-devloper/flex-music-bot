export interface VoiceResult {
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

export interface TrackPlaybackEvent {
  chatId: number;
  queueId: string;
  query: string;
  title: string;
  url?: string;
  durationSeconds: number;
}
