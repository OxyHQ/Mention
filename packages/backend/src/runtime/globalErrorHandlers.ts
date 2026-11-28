import { config } from '../config';
import { sanitizeLogValue } from '../utils/logger';

/**
 * Install the process-level last-resort handlers.
 *
 * Call this before bootstrap starts any asynchronous work. Imports must finish
 * first so the sanitizer and validated configuration bindings are initialized
 * when a handler runs.
 */
export function registerGlobalErrorHandlers(): void {
  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    // Keep this fallback independent from the logger transport, but sanitize the
    // payload with the same central policy before writing it.
    console.error('Unhandled promise rejection', sanitizeLogValue(reason));
    // In production, exit to let the process manager restart cleanly
    if (config.runtime.isProduction) {
      process.exit(1);
    }
  });

  process.on('uncaughtException', (error: Error) => {
    console.error('Uncaught exception', sanitizeLogValue(error));
    // Always exit on uncaught exceptions — the process state is unreliable
    process.exit(1);
  });
}
