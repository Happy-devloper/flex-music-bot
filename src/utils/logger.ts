import path from 'node:path';
import process from 'node:process';
import winston from 'winston';
import { config } from '../config/env.js';

const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaText = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${String(timestamp)} ${level}: ${String(message)}${metaText}`;
  })
);

export const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: {
    service: 'telegram-music-bot',
    pid: process.pid
  },
  transports: [
    new winston.transports.Console({
      format: config.isProduction ? logFormat : consoleFormat
    }),
    new winston.transports.File({
      filename: path.join('logs', 'error.log'),
      level: 'error',
      format: logFormat
    }),
    new winston.transports.File({
      filename: path.join('logs', 'combined.log'),
      format: logFormat
    })
  ],
  exitOnError: false
});
