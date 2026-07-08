export type TelegramChatType = 'group' | 'supergroup';

export type LoopMode = 'off' | 'track' | 'queue';

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface RequesterSnapshot {
  telegramId: number;
  firstName: string;
  username?: string;
}

export interface QueueTrack {
  title: string;
  durationSeconds: number;
  requester: RequesterSnapshot;
  url: string;
  thumbnailUrl?: string;
  source: 'youtube';
  addedAt: Date;
}

export interface PlaylistTrack {
  title: string;
  durationSeconds: number;
  url: string;
  thumbnailUrl?: string;
  source: 'youtube';
}
