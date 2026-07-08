import { config } from './config/env.js';
import { voiceAssistant } from './assistant/voice-assistant.js';
import { connectDatabase, disconnectDatabase } from './database/mongoose.js';
import { createBot, startBot, stopBot } from './bot/index.js';
import { logger } from './utils/logger.js';
import './models/index.js';

async function bootstrap(): Promise<void> {
  logger.info('Starting Telegram Music Bot', {
    environment: config.nodeEnv,
    logLevel: config.logLevel
  });

  await connectDatabase();
  await voiceAssistant.connect();
  const bot = createBot();
  await startBot(bot);

  logger.info('Module 4 bootstrap is ready. Bot commands and voice assistant are online.');
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  logger.info('Received shutdown signal', { signal });
  await stopBot();
  await voiceAssistant.disconnect();
  await disconnectDatabase();
  process.exit(0);
}

process.once('SIGINT', (signal) => {
  void shutdown(signal);
});

process.once('SIGTERM', (signal) => {
  void shutdown(signal);
});

bootstrap().catch((error: unknown) => {
  logger.error('Fatal bootstrap error', { error });
  process.exit(1);
});
