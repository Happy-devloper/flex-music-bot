import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';
import type { TelegramChatType } from './types.js';

export interface Group {
  chatId: number;
  title: string;
  username?: string;
  type: TelegramChatType;
  isActive: boolean;
  lastSeenAt: Date;
  voiceChat: {
    isActive: boolean;
    assistantUserId?: number;
    lastJoinAt?: Date;
    lastLeaveAt?: Date;
    lastDisconnectAt?: Date;
  };
}

export type GroupDocument = HydratedDocument<Group>;

const groupSchema = new Schema<Group>(
  {
    chatId: { type: Number, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    username: { type: String, trim: true },
    type: { type: String, enum: ['group', 'supergroup'], required: true },
    isActive: { type: Boolean, default: true, index: true },
    lastSeenAt: { type: Date, default: () => new Date(), index: true },
    voiceChat: {
      isActive: { type: Boolean, default: false },
      assistantUserId: { type: Number },
      lastJoinAt: { type: Date },
      lastLeaveAt: { type: Date },
      lastDisconnectAt: { type: Date }
    }
  },
  {
    collection: 'groups',
    timestamps: true
  }
);

export const GroupModel =
  (mongoose.models.Group as Model<Group> | undefined) ?? model<Group>('Group', groupSchema);
