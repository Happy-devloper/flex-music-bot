import type { NextFunction } from 'grammy';
import { RATE_LIMITS } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import type { BotContext } from '../context.js';

interface RateLimitBucket {
  count: number;
  resetAt: number;
  warned: boolean;
}

const commandBuckets = new Map<string, RateLimitBucket>();

export async function rateLimitMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!ctx.message?.text?.startsWith('/')) {
    await next();
    return;
  }

  const key = createRateLimitKey(ctx);
  const now = Date.now();
  const bucket = commandBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    commandBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMITS.commandWindowMs,
      warned: false
    });
    await next();
    return;
  }

  bucket.count += 1;

  if (bucket.count <= RATE_LIMITS.maxCommandsPerWindow) {
    await next();
    return;
  }

  logger.warn('Command rate limit exceeded', {
    key,
    count: bucket.count,
    resetAt: bucket.resetAt
  });

  if (!bucket.warned) {
    bucket.warned = true;
    await ctx.reply('Too many commands too quickly. Please slow down for a moment.');
  }
}

function createRateLimitKey(ctx: BotContext): string {
  const chatId = ctx.chat?.id ?? 'private';
  const userId = ctx.from?.id ?? 'anonymous';
  return `${chatId}:${userId}`;
}
