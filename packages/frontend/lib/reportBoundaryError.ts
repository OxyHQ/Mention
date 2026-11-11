import type { ErrorInfo } from 'react';
import { createLogger } from '@oxy.so/core/logger';
import { recoverChunkError } from '@/lib/chunkReload';

const logger = createLogger('ErrorBoundary');

/** The one report for every boundary: the app-root one and the shell's panels. */
export function reportBoundaryError(error: Error, errorInfo: ErrorInfo): void {
  recoverChunkError(error);
  logger.error('Error caught by boundary', error, { errorInfo });
}
