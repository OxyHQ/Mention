import type { ErrorInfo, ReactNode } from 'react';
import { PanelErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { usePathname } from '@/lib/navigation/router';

/**
 * The main panel's error boundary: a screen that throws fails inside its
 * panel, never the whole app, and navigating to another route recovers it.
 * It reads the path itself, so the shell around it does not have to (the shell
 * re-rendered whole on every navigation to hand the panel its reset key).
 */
export function RouteErrorBoundary({
  onError,
  children,
}: {
  onError: (error: Error, info: ErrorInfo) => void;
  children: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <PanelErrorBoundary resetKey={pathname} onError={onError}>
      {children}
    </PanelErrorBoundary>
  );
}
