import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface Props {
  children: React.ReactNode;
  postId?: string;
}

interface State {
  hasError: boolean;
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
    console.warn(`[PostErrorBoundary] Post ${this.props.postId || 'unknown'} crashed:`, error.message);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.text}>This post could not be displayed.</Text>
          <TouchableOpacity onPress={this.handleRetry} style={styles.retryButton}>
            <Text style={styles.retryText}>Tap to retry</Text>
          </TouchableOpacity>
        </View>
      );
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
    borderBottomColor: 'rgba(0,0,0,0.08)',
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
