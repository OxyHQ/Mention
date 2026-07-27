import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from './logger';

const APP_NAME = 'mention';
const INITIAL_RETRY_DELAY_MS = 1_000;

let connectPromise: Promise<typeof mongoose> | null = null;

export interface DatabaseConnectionOptions {
  /**
   * Per-process socket timeout. Long-running one-shot migrations may override
   * the web runtime's tighter timeout without weakening request-serving tasks.
   */
  socketTimeoutMS?: number;
  /** Keep one-shot pools small; web tasks continue to use the configured pool. */
  maxPoolSize?: number;
  minPoolSize?: number;
  /** Migrations that select canonical state must read the primary. */
  readPreference?: mongoose.ConnectOptions['readPreference'];
}

function retryDelay(attempt: number): number {
  return INITIAL_RETRY_DELAY_MS * 2 ** attempt;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function databaseName(): string {
  return `${APP_NAME}-${config.runtime.nodeEnv}`;
}

function describeConnectionError(error: unknown): { code: string } {
  const code =
    error instanceof Error && 'code' in error && error.code
      ? String(error.code)
      : error instanceof Error && 'syscall' in error && error.syscall
        ? String(error.syscall)
        : '';
  return { code };
}

async function connectWithRetry(
  mongoUri: string,
  dbName: string,
  attempt: number,
  maxRetries: number,
  options: DatabaseConnectionOptions,
): Promise<typeof mongoose> {
  try {
    await mongoose.connect(mongoUri, {
      dbName,
      autoIndex: !config.runtime.isProduction,
      autoCreate: !config.runtime.isProduction,
      serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMS,
      socketTimeoutMS: options.socketTimeoutMS ?? config.db.socketTimeoutMS,
      maxPoolSize: options.maxPoolSize ?? config.db.maxPoolSize,
      minPoolSize: options.minPoolSize ?? config.db.minPoolSize,
      maxIdleTimeMS: config.db.maxIdleTimeMS,
      readPreference: options.readPreference ?? config.mongoReadPreference,
      w: 'majority',
      wtimeoutMS: 5_000,
      retryWrites: true,
      retryReads: true,
      heartbeatFrequencyMS: config.db.heartbeatFrequencyMS,
    });

    logger.info('Connected to MongoDB successfully');
    return mongoose;
  } catch (error: unknown) {
    const { code } = describeConnectionError(error);

    if (attempt < maxRetries) {
      const delay = retryDelay(attempt - 1);
      if (attempt <= 3) {
        logger.warn(
          `MongoDB connection failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`,
          { code },
        );
      }
      await wait(delay);
      return connectWithRetry(
        mongoUri,
        dbName,
        attempt + 1,
        maxRetries,
        options,
      );
    }

    logger.error(`Failed to connect to MongoDB after ${maxRetries} attempts`, {
      code,
    });
    throw error;
  }
}

export async function connectToDatabase(
  options: DatabaseConnectionOptions = {},
): Promise<typeof mongoose> {
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
  logger.debug('Attempting to connect to MongoDB');

  const configuredRetries = config.db.maxRetries;
  const maxRetries = Number.isFinite(configuredRetries)
    ? Math.max(1, configuredRetries)
    : 5;
  const pendingConnection = connectWithRetry(
    mongoUri,
    dbName,
    1,
    maxRetries,
    options,
  );
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
