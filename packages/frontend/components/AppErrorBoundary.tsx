import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';
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

  // The boundary sits above the app shell's ContentPanel, so the fallback
  // paints its own surface instead of borrowing the panel's.
  return (
    <View className="flex-1 bg-background">
      <ErrorScreen
        title={t('error.boundary.title')}
        message={t('error.boundary.message')}
        onRetry={onRetry}
        hideBackButton
      />
    </View>
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
