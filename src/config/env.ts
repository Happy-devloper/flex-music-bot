import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  API_ID: z.coerce.number().int().positive(),
  API_HASH: z.string().min(1),
  BOT_TOKEN: z.string().min(1),
  MONGO_URI: z.string().url().or(z.string().startsWith('mongodb://')),
  SESSION_STRING: z.string().min(1),
  LOG_GROUP: z.coerce.number().int(),
  OWNER_ID: z.coerce.number().int().positive(),
  YT_DLP_PATH: z.string().min(1).optional(),
  YT_DLP_COOKIES: z.string().min(1).optional(),
  FFMPEG_PATH: z.string().min(1).optional(),
  VOICE_ENGINE: z.enum(['gram-tgcalls', 'pytgcalls']).default('gram-tgcalls'),
  PYROGRAM_SESSION_STRING: z.string().min(1).optional(),
  PYTHON_VOICE_BIN: z.string().min(1).default('py'),
  PYTHON_VOICE_ARGS: z.string().min(1).default('-3.11 voice_worker/worker.py'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']).default('info')
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  const details = parsedEnv.error.flatten().fieldErrors;
  throw new Error(`Invalid environment configuration: ${JSON.stringify(details)}`);
}

export const config = {
  apiId: parsedEnv.data.API_ID,
  apiHash: parsedEnv.data.API_HASH,
  botToken: parsedEnv.data.BOT_TOKEN,
  mongoUri: parsedEnv.data.MONGO_URI,
  sessionString: parsedEnv.data.SESSION_STRING,
  logGroup: parsedEnv.data.LOG_GROUP,
  ownerId: parsedEnv.data.OWNER_ID,
  ytDlpPath: parsedEnv.data.YT_DLP_PATH,
  ytDlpCookies: parsedEnv.data.YT_DLP_COOKIES,
  ffmpegPath: parsedEnv.data.FFMPEG_PATH,
  voiceEngine: parsedEnv.data.VOICE_ENGINE,
  pyrogramSessionString: parsedEnv.data.PYROGRAM_SESSION_STRING,
  pythonVoiceBin: parsedEnv.data.PYTHON_VOICE_BIN,
  pythonVoiceArgs: parsedEnv.data.PYTHON_VOICE_ARGS,
  nodeEnv: parsedEnv.data.NODE_ENV,
  logLevel: parsedEnv.data.LOG_LEVEL,
  isProduction: parsedEnv.data.NODE_ENV === 'production'
} as const;

export type AppConfig = typeof config;
