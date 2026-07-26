import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from './logger';

const APP_NAME = 'mention';
const INITIAL_RETRY_DELAY_MS = 1_000;

let connectPromise: Promise<typeof mongoose> | null = null;

function retryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY_MS * 2 ** attempt;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function databaseName(): string {
  return `${APP_NAME}-${config.runtime.nodeEnv}`;
}

function describeConnectionError(error: unknown): { code: string; message: string } {
  const code =
    error instanceof Error && 'code' in error && error.code
      ? String(error.code)
      : error instanceof Error && 'syscall' in error && error.syscall
        ? String(error.syscall)
        : '';
  return {
    code,
    message: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
  };
}

async function connectWithRetry(
  mongoUri: string,
  dbName: string,
  attempt: number,
  maxRetries: number,
): Promise<typeof mongoose> {
  try {
    await mongoose.connect(mongoUri, {
      dbName,
      autoIndex: !config.runtime.isProduction,
      autoCreate: !config.runtime.isProduction,
      serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMS,
      socketTimeoutMS: config.db.socketTimeoutMS,
      maxPoolSize: config.db.maxPoolSize,
      minPoolSize: config.db.minPoolSize,
      maxIdleTimeMS: config.db.maxIdleTimeMS,
      readPreference: config.mongoReadPreference,
      w: 'majority',
      wtimeoutMS: 5_000,
      retryWrites: true,
      retryReads: true,
      heartbeatFrequencyMS: config.db.heartbeatFrequencyMS,
    });

    logger.info('Connected to MongoDB successfully');
    return mongoose;
  } catch (error: unknown) {
    const { code, message } = describeConnectionError(error);

    if (attempt < maxRetries) {
      const delay = retryDelay(attempt - 1);
      if (attempt <= 3) {
        logger.warn(
          `MongoDB connection failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`,
          { code, message },
        );
      }
      await wait(delay);
      return connectWithRetry(mongoUri, dbName, attempt + 1, maxRetries);
    }

    logger.error(`Failed to connect to MongoDB after ${maxRetries} attempts`, {
      code,
      message,
    });
    throw error;
  }
}

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }
  if (connectPromise) {
    return connectPromise;
  }

  const mongoUri = config.mongoUri;
  if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not defined');
  }

  const dbName = databaseName();
  const sanitizedUri = mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
  logger.debug(`Attempting to connect to MongoDB: ${sanitizedUri.substring(0, 100)}...`);
  logger.debug(`Using database: ${dbName}`);

  const configuredRetries = config.db.maxRetries;
  const maxRetries = Number.isFinite(configuredRetries)
    ? Math.max(1, configuredRetries)
    : 5;
  const pendingConnection = connectWithRetry(mongoUri, dbName, 1, maxRetries);
  connectPromise = pendingConnection;

  try {
    return await pendingConnection;
  } finally {
    // A resolved promise must not mask a later disconnect. Concurrent callers
    // still share this attempt, while a later outage can start a fresh one.
    if (connectPromise === pendingConnection) {
      connectPromise = null;
    }
  }
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export function getDatabaseStats() {
  const state = mongoose.connection.readyState;
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  return {
    state: states[state] || 'unknown',
    readyState: state,
    host: mongoose.connection.host,
    port: mongoose.connection.port,
    name: mongoose.connection.name,
  };
}
