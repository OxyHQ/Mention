import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '@/components/common/EmptyState';

interface ErrorProps {
  title?: string;
  message?: string;
  onRetry?: () => void | Promise<void>;
  onGoBack?: () => void;
  hideBackButton?: boolean;
  sideBorders?: boolean;
  style?: ViewStyle;
}

/**
 * A whole screen that failed to load: the shared EmptyState in its error form
 * — the "could not load" sticker, a retry — with a quieter way back beneath it.
 */
export function Error({
  title = 'Something went wrong',
  message = 'An unexpected error occurred. Please try again.',
  onRetry,
  onGoBack,
  hideBackButton = false,
  style,
}: ErrorProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handleGoBack = () => {
    if (onGoBack) {
      onGoBack();
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/');
    }
  };

  return (
    <View
      className="flex-1 justify-center items-center py-8 px-6"
      style={StyleSheet.flatten([
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 },
        style,
      ])}
    >
      <EmptyState
        error={{
          title,
          message,
          onRetry: onRetry
            ? async () => {
                await onRetry();
              }
            : undefined,
        }}
        footer={
          hideBackButton ? undefined : (
            <Button
              appearance="subtle"
              tone="neutral"
              leadingIcon={RiArrowLeftLine}
              onPress={handleGoBack}
            >
              {router.canGoBack() ? 'Go back' : 'Go home'}
            </Button>
          )
        }
      />
    </View>
  );
}
