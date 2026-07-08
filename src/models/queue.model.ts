import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { LoopMode, PlaybackState, QueueTrack, RequesterSnapshot } from './types.js';

export interface MusicQueue {
  chatId: number;
  tracks: QueueTrack[];
  currentTrack?: QueueTrack;
  playbackState: PlaybackState;
  loopMode: LoopMode;
  volume: number;
  seekOffsetSeconds: number;
  shuffledAt?: Date;
  lastPlayedAt?: Date;
}

export type MusicQueueDocument = HydratedDocument<MusicQueue>;

const requesterSchema = new Schema<RequesterSnapshot>(
  {
    telegramId: { type: Number, required: true },
    firstName: { type: String, required: true, trim: true },
    username: { type: String, trim: true }
  },
  { _id: false }
);

const queueTrackSchema = new Schema<QueueTrack>(
  {
    title: { type: String, required: true, trim: true },
    durationSeconds: { type: Number, required: true, min: 0 },
    requester: { type: requesterSchema, required: true },
    url: { type: String, required: true, trim: true },
    thumbnailUrl: { type: String, trim: true },
    source: { type: String, enum: ['youtube'], default: 'youtube', required: true },
    addedAt: { type: Date, default: () => new Date(), required: true }
  },
  { _id: false }
);

const queueSchema = new Schema<MusicQueue>(
  {
    chatId: { type: Number, required: true, unique: true, index: true },
    tracks: { type: [queueTrackSchema], default: [] },
    currentTrack: { type: queueTrackSchema },
    playbackState: { type: String, enum: ['idle', 'playing', 'paused'], default: 'idle' },
    loopMode: { type: String, enum: ['off', 'track', 'queue'], default: 'off' },
    volume: { type: Number, default: 100, min: 1, max: 200 },
    seekOffsetSeconds: { type: Number, default: 0, min: 0 },
    shuffledAt: { type: Date },
    lastPlayedAt: { type: Date }
  },
  {
    collection: 'queue',
    timestamps: true
  }
);

export const MusicQueueModel =
  (mongoose.models.MusicQueue as Model<MusicQueue> | undefined) ??
  model<MusicQueue>('MusicQueue', queueSchema);
