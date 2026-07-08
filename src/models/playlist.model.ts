import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { PlaylistTrack } from './types.js';

export interface Playlist {
  ownerTelegramId: number;
  groupChatId?: number;
  title: string;
  description?: string;
  tracks: PlaylistTrack[];
  isPublic: boolean;
}

export type PlaylistDocument = HydratedDocument<Playlist>;

const playlistTrackSchema = new Schema<PlaylistTrack>(
  {
    title: { type: String, required: true, trim: true },
    durationSeconds: { type: Number, required: true, min: 0 },
    url: { type: String, required: true, trim: true },
    thumbnailUrl: { type: String, trim: true },
    source: { type: String, enum: ['youtube'], default: 'youtube', required: true }
  },
  { _id: false }
);

const playlistSchema = new Schema<Playlist>(
  {
    ownerTelegramId: { type: Number, required: true, index: true },
    groupChatId: { type: Number, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    tracks: { type: [playlistTrackSchema], default: [] },
    isPublic: { type: Boolean, default: false, index: true }
  },
  {
    collection: 'playlists',
    timestamps: true
  }
);

playlistSchema.index({ ownerTelegramId: 1, title: 1 }, { unique: true });

export const PlaylistModel =
  (mongoose.models.Playlist as Model<Playlist> | undefined) ??
  model<Playlist>('Playlist', playlistSchema);
