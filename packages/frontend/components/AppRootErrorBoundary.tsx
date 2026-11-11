import type { ErrorInfo, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppErrorFallback, ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { createLogger } from '@oxy.so/core/logger';
import { recoverChunkError } from '@/lib/chunkReload';

const logger = createLogger('ErrorBoundary');

/** The one report for every boundary: this last-resort one and the shell's panels. */
export function reportBoundaryError(error: Error, errorInfo: ErrorInfo): void {
  recoverChunkError(error);
  logger.error('Error caught by boundary', error, { errorInfo });
}

/**
 * The last-resort boundary above the app shell. Bloom's `AppErrorFallback`
 * reads no theme or router context (the tree above it has already crashed),
 * which is why it can paint its own surface here.
 */
export function AppRootErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <ErrorBoundary
      onError={reportBoundaryError}
      fallback={(ctx) => (
        <AppErrorFallback
          {...ctx}
          title={t('error.boundary.title')}
          message={t('error.boundary.message')}
          maxRetries={3}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
