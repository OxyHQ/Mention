import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AppErrorFallback, ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { reportBoundaryError } from '@/lib/reportBoundaryError';

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
