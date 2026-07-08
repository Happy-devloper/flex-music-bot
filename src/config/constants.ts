export const DEFAULT_PREFIX = '/';

export const QUEUE_LIMITS = {
  defaultMaxSize: 50,
  hardMaxSize: 200,
  defaultMaxSongDurationSeconds: 60 * 15
} as const;

export const RATE_LIMITS = {
  commandWindowMs: 10_000,
  maxCommandsPerWindow: 8
} as const;
