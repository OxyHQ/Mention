import React, { useState } from 'react';
import { View, Text, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine, RiErrorWarningFill, RiRefreshLine } from '@oxy.so/bloom/icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { flattenStyleArray } from '@/styles/shared';

interface ErrorProps {
  title?: string;
  message?: string;
  onRetry?: () => void | Promise<void>;
  onGoBack?: () => void;
  hideBackButton?: boolean;
  sideBorders?: boolean;
  style?: ViewStyle;
}

export function Error({
  title = 'Something went wrong',
  message = 'An unexpected error occurred. Please try again.',
  onRetry,
  onGoBack,
  hideBackButton = false,
  style,
}: ErrorProps) {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [isRetrying, setIsRetrying] = useState(false);

  const handleGoBack = () => {
    if (onGoBack) {
      onGoBack();
    } else if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/');
    }
  };

  const handleRetry = async () => {
    if (!onRetry || isRetrying) return;
    const result = onRetry();
    if (result instanceof Promise) {
      setIsRetrying(true);
      try {
        await result;
      } finally {
        setIsRetrying(false);
      }
    }
  };

  return (
    <View
      className="flex-1 justify-center items-center py-8 px-6"
      style={flattenStyleArray([
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 },
        style,
      ])}
    >
      <View className="items-center max-w-[320px] w-full">
        <View
          className="w-[72px] h-[72px] rounded-full justify-center items-center mb-3"
          style={{ backgroundColor: theme.colors.error + '15' }}
        >
          <RiErrorWarningFill width={36} height={36} fill={theme.colors.error} />
        </View>

        <Text
          className="text-lg font-bold text-center text-foreground mb-1.5"
          style={{ letterSpacing: -0.3 }}
        >
          {title}
        </Text>

        <Text
          className="text-sm text-center text-muted-foreground mb-4"
          style={{ lineHeight: 20 }}
        >
          {message}
        </Text>

        <View className="w-full items-center gap-3">
          {onRetry && (
            <Button
              variant="primary"
              leadingIcon={RiRefreshLine}
              loading={isRetrying}
              onPress={handleRetry}
              className="min-w-[140px]"
            >
              Try again
            </Button>
          )}

          {!hideBackButton && (
            <Button
              variant="secondary"
              leadingIcon={RiArrowLeftLine}
              onPress={handleGoBack}
              className="min-w-[140px]"
            >
              {router.canGoBack() ? 'Go back' : 'Go home'}
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}
