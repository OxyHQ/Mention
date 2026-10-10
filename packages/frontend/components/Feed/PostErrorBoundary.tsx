import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { logger } from '@oxy.so/core/logger';

interface Props {
  children: React.ReactNode;
  postId?: string;
}

interface State {
  hasError: boolean;
  /** The post the error belongs to — a recycled row showing another post starts clean. */
  errorPostId?: string;
}

function PostErrorFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <View className="border-border" style={styles.container}>
      <Text className="text-muted-foreground text-sm">This post could not be displayed.</Text>
      <Button appearance="plain" size="sm" onPress={onRetry}>
        Tap to retry
      </Button>
    </View>
  );
}

/**
 * Error boundary that wraps individual post items.
 * Prevents a single malformed post from crashing the entire feed.
 */
export class PostErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  // FlashList recycles the boundary along with its row, so an error caught for
  // one post would otherwise keep "This post could not be displayed" on every
  // post the cell is reused for.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.hasError && state.errorPostId !== undefined && state.errorPostId !== props.postId) {
      return { hasError: false, errorPostId: undefined };
    }
    if (state.hasError && state.errorPostId === undefined) {
      return { errorPostId: props.postId };
    }
    return null;
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.warn(
      `[PostErrorBoundary] Post ${this.props.postId || 'unknown'} crashed: ${error.message}`,
    );
  }

  handleRetry = () => {
    this.setState({ hasError: false, errorPostId: undefined });
  };

  render() {
    if (this.state.hasError) {
      return <PostErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
