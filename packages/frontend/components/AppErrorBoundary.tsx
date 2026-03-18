import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Error as ErrorScreen } from '@/components/Error';

interface AppErrorBoundaryProps {
  children: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <ErrorScreen
      title={t('error.boundary.title')}
      message={t('error.boundary.message')}
      onRetry={onRetry}
      hideBackButton
    />
  );
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  static displayName = 'AppErrorBoundary';

  state: AppErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}
