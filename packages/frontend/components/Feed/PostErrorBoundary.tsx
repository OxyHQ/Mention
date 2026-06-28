import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { logger } from '@/lib/logger';

interface Props {
  children: React.ReactNode;
  postId?: string;
}

interface State {
  hasError: boolean;
}

function PostErrorFallback({ onRetry }: { onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.container, { borderBottomColor: theme.colors.border }]}>
      <Text style={styles.text}>This post could not be displayed.</Text>
      <TouchableOpacity onPress={onRetry} style={styles.retryButton}>
        <Text style={styles.retryText}>Tap to retry</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * Error boundary that wraps individual post items.
 * Prevents a single malformed post from crashing the entire feed.
 */
export class PostErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.warn(`[PostErrorBoundary] Post ${this.props.postId || 'unknown'} crashed: ${error.message}`);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
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
  text: {
    fontSize: 14,
    color: '#999',
  },
  retryButton: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  retryText: {
    fontSize: 13,
    color: '#007AFF',
  },
});
