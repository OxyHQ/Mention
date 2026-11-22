import { recoverChunkError } from '@/lib/chunkReload';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { logger } from '@oxy.so/core/logger';

import { Button as LButton, Text as LText, toElement } from '@oxy.so/bloom-language';

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
      {toElement(
        LText('This post could not be displayed.').foreground('muted').font('14').leading('20px'),
      )}
      {toElement(LButton(LText('Tap to retry')).style('plain').size('sm').onPress(onRetry))}
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
    recoverChunkError(error);
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
