import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

export interface User {
  telegramId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isBot: boolean;
  isOwner: boolean;
  lastSeenAt: Date;
}

export type UserDocument = HydratedDocument<User>;

const userSchema = new Schema<User>(
  {
    telegramId: { type: Number, required: true, unique: true, index: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    username: { type: String, trim: true, index: true },
    languageCode: { type: String, trim: true },
    isBot: { type: Boolean, default: false },
    isOwner: { type: Boolean, default: false, index: true },
    lastSeenAt: { type: Date, default: () => new Date(), index: true }
  },
  {
    collection: 'users',
    timestamps: true
  }
);

export const UserModel =
  (mongoose.models.User as Model<User> | undefined) ?? model<User>('User', userSchema);
