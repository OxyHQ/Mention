import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  ...(isProduction
    ? {
        // JSON output in production for log aggregation
        formatters: {
          level: (label: string) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // Pretty print in development
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
});

interface LoggerFunction {
  (message: string, ...args: unknown[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: (message: string, error?: unknown) => void;
  debug: LoggerFunction;
}

/** Fold variadic log args into a single pino-mergeable object. */
function mergeLogArgs(args: unknown[]): Record<string, unknown> {
  const first = args[0];
  if (args.length === 1 && first !== null && typeof first === 'object') {
    return first as Record<string, unknown>;
  }
  return { data: args };
}

export const logger: Logger = {
  info: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.info(mergeLogArgs(args), message);
    } else {
      pinoLogger.info(message);
    }
  },
  error: (message: string, error?: unknown) => {
    if (error instanceof Error) {
      pinoLogger.error({ err: error }, message);
    } else if (error) {
      pinoLogger.error({ data: error }, message);
    } else {
      pinoLogger.error(message);
    }
  },
  warn: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.warn(mergeLogArgs(args), message);
    } else {
      pinoLogger.warn(message);
    }
  },
  debug: (message: string, ...args: unknown[]) => {
    if (args.length > 0) {
      pinoLogger.debug(mergeLogArgs(args), message);
    } else {
      pinoLogger.debug(message);
    }
  },
};
