import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import { DEFAULT_PREFIX, QUEUE_LIMITS } from '../config/constants.js';

export interface Settings {
  chatId: number;
  commandPrefix: string;
  adminOnlyMode: boolean;
  autoplay: boolean;
  maxSongDurationSeconds: number;
  maxQueueSize: number;
  volume: number;
}

export type SettingsDocument = HydratedDocument<Settings>;

const settingsSchema = new Schema<Settings>(
  {
    chatId: { type: Number, required: true, unique: true, index: true },
    commandPrefix: {
      type: String,
      required: true,
      default: DEFAULT_PREFIX,
      minlength: 1,
      maxlength: 5
    },
    adminOnlyMode: { type: Boolean, default: false },
    autoplay: { type: Boolean, default: true },
    maxSongDurationSeconds: {
      type: Number,
      default: QUEUE_LIMITS.defaultMaxSongDurationSeconds,
      min: 30
    },
    maxQueueSize: {
      type: Number,
      default: QUEUE_LIMITS.defaultMaxSize,
      min: 1,
      max: QUEUE_LIMITS.hardMaxSize
    },
    volume: { type: Number, default: 100, min: 1, max: 200 }
  },
  {
    collection: 'settings',
    timestamps: true
  }
);

export const SettingsModel =
  (mongoose.models.Settings as Model<Settings> | undefined) ??
  model<Settings>('Settings', settingsSchema);
