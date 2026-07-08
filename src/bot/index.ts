import { autoRetry } from '@grammyjs/auto-retry';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { registerBasicCommands, registerBotCommands } from './commands/basic.js';
import { activityMiddleware } from './middleware/activity.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';

let runner: RunnerHandle | null = null;

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  bot.api.config.use(autoRetry());
  bot.use(activityMiddleware);
  bot.use(rateLimitMiddleware);

  registerBasicCommands(bot);

  bot.catch((error) => {
    const ctx = error.ctx;
    const thrown = error.error;

    if (thrown instanceof GrammyError) {
      logger.error('Telegram API error', {
        updateId: ctx.update.update_id,
        errorCode: thrown.error_code,
        description: thrown.description
      });
      return;
    }

    if (thrown instanceof HttpError) {
      logger.error('Telegram HTTP error', {
        updateId: ctx.update.update_id,
        error: thrown.error
      });
      return;
    }

    logger.error('Bot update error', {
      updateId: ctx.update.update_id,
      error: thrown
    });
  });

  return bot;
}

export async function startBot(bot: Bot): Promise<void> {
  await registerBotCommands(bot);
  runner = run(bot);
  logger.info('Telegram bot polling started');
}

export async function stopBot(): Promise<void> {
  if (!runner) {
    return;
  }

  await runner.stop();
  runner = null;
  logger.info('Telegram bot polling stopped');
}
