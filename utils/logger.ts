interface LoggerFunction {
  (message: string, ...args: any[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

const PREFIX = '[Session]';

const createLogger = (): Logger => {
  return {
    info: (message: string, ...args: any[]) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`${PREFIX} [INFO] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(`${PREFIX} [WARN] ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      console.error(`${PREFIX} [ERROR] ${message}`, ...args);
    },
    debug: (message: string, ...args: any[]) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`${PREFIX} [DEBUG] ${message}`, ...args);
      }
    }
  };
};

export const logger = createLogger();