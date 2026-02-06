import pino from 'pino';

interface LoggerFunction {
  (message: string, ...args: any[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

// Configure log level from environment, defaulting to 'info'
const logLevel = process.env.LOG_LEVEL || 'info';

// Configure pino with structured logging
const pinoLogger = pino({
  level: logLevel,
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'yyyy-MM-dd HH:mm:ss',
      ignore: 'pid,hostname',
    }
  } : undefined,
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Helper to format additional arguments as structured metadata
function formatArgs(args: any[]): any {
  if (args.length === 0) return undefined;
  if (args.length === 1) {
    const arg = args[0];
    // If it's an error or object, return it directly
    if (arg instanceof Error || (typeof arg === 'object' && arg !== null)) {
      return arg;
    }
    // Otherwise wrap primitive values
    return { data: arg };
  }
  // Multiple arguments - create an object with indexed keys
  return { data: args };
}

// Wrapper to maintain existing API while using pino internally
export const logger: Logger = {
  info: (message: string, ...args: any[]) => {
    const meta = formatArgs(args);
    if (meta) {
      pinoLogger.info(meta, message);
    } else {
      pinoLogger.info(message);
    }
  },
  error: (message: string, ...args: any[]) => {
    const meta = formatArgs(args);
    if (meta) {
      pinoLogger.error(meta, message);
    } else {
      pinoLogger.error(message);
    }
  },
  warn: (message: string, ...args: any[]) => {
    const meta = formatArgs(args);
    if (meta) {
      pinoLogger.warn(meta, message);
    } else {
      pinoLogger.warn(message);
    }
  },
  debug: (message: string, ...args: any[]) => {
    const meta = formatArgs(args);
    if (meta) {
      pinoLogger.debug(meta, message);
    } else {
      pinoLogger.debug(message);
    }
  }
};