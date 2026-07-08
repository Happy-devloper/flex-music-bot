import type { NextFunction } from 'grammy';
import { config } from '../../config/env.js';
import { GroupModel, UserModel } from '../../models/index.js';
import { logger } from '../../utils/logger.js';
import type { BotContext } from '../context.js';

export async function activityMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  await persistUser(ctx);
  await persistGroup(ctx);
  await next();
}

async function persistUser(ctx: BotContext): Promise<void> {
  const user = ctx.from;

  if (!user) {
    return;
  }

  try {
    await UserModel.updateOne(
      { telegramId: user.id },
      {
        $set: {
          firstName: user.first_name,
          lastName: user.last_name,
          username: user.username,
          languageCode: user.language_code,
          isBot: user.is_bot,
          isOwner: user.id === config.ownerId,
          lastSeenAt: new Date()
        }
      },
      { upsert: true }
    );
  } catch (error) {
    logger.warn('Failed to persist user activity', { error, userId: user.id });
  }
}

async function persistGroup(ctx: BotContext): Promise<void> {
  const chat = ctx.chat;

  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    return;
  }

  try {
    await GroupModel.updateOne(
      { chatId: chat.id },
      {
        $set: {
          title: chat.title,
          username: chat.type === 'supergroup' ? chat.username : undefined,
          type: chat.type,
          isActive: true,
          lastSeenAt: new Date()
        },
        $setOnInsert: {
          voiceChat: {
            isActive: false
          }
        }
      },
      { upsert: true }
    );
  } catch (error) {
    logger.warn('Failed to persist group activity', { chatId: chat.id, error });
  }
}
