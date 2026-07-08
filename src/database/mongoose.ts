import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const connectedState = mongoose.ConnectionStates.connected;

const mongoOptions: mongoose.ConnectOptions = {
  autoIndex: !config.isProduction,
  maxPoolSize: 10,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000
};

let connectionPromise: Promise<typeof mongoose> | null = null;

mongoose.set('strictQuery', true);

mongoose.connection.on('connected', () => {
  logger.info('MongoDB connected');
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (error: Error) => {
  logger.error('MongoDB connection error', { error });
});

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === connectedState) {
    return mongoose;
  }

  connectionPromise ??= mongoose.connect(config.mongoUri, mongoOptions);
  return connectionPromise;
}

export async function disconnectDatabase(): Promise<void> {
  connectionPromise = null;
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === connectedState;
}
