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
  (message: string, ...args: any[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

export const logger: Logger = {
  info: (message: string, ...args: any[]) => {
    if (args.length > 0) {
      const merged = args.length === 1 && typeof args[0] === 'object' ? args[0] : { data: args };
      pinoLogger.info(merged, message);
    } else {
      pinoLogger.info(message);
    }
  },
  error: (message: string, error?: any) => {
    if (error instanceof Error) {
      pinoLogger.error({ err: error }, message);
    } else if (error) {
      pinoLogger.error({ data: error }, message);
    } else {
      pinoLogger.error(message);
    }
  },
  warn: (message: string, ...args: any[]) => {
    if (args.length > 0) {
      const merged = args.length === 1 && typeof args[0] === 'object' ? args[0] : { data: args };
      pinoLogger.warn(merged, message);
    } else {
      pinoLogger.warn(message);
    }
  },
  debug: (message: string, ...args: any[]) => {
    if (args.length > 0) {
      const merged = args.length === 1 && typeof args[0] === 'object' ? args[0] : { data: args };
      pinoLogger.debug(merged, message);
    } else {
      pinoLogger.debug(message);
    }
  },
};
