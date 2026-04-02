import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { flattenStyleArray } from '@/utils/theme';

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
      className="flex-1 justify-center items-center py-8 px-6 bg-background"
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
          <Ionicons
            name="alert-circle-outline"
            size={36}
            color={theme.colors.error}
          />
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
            <TouchableOpacity
              className="flex-row items-center justify-center py-2.5 px-5 rounded-[20px] min-w-[140px] gap-1.5 bg-primary"
              style={{ opacity: isRetrying ? 0.6 : 1 }}
              onPress={handleRetry}
              disabled={isRetrying}
              activeOpacity={0.8}
            >
              {isRetrying ? (
                <Loading variant="inline" size="small" style={{ flex: undefined }} />
              ) : (
                <>
                  <Ionicons
                    name="refresh"
                    size={18}
                    color={theme.colors.card}
                  />
                  <Text
                    className="text-[15px] font-semibold"
                    style={{ color: theme.colors.card }}
                  >
                    Try again
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {!hideBackButton && (
            <TouchableOpacity
              className="flex-row items-center justify-center py-2.5 px-5 rounded-[20px] min-w-[140px] gap-1.5 border border-border"
              onPress={handleGoBack}
              activeOpacity={0.8}
            >
              <Ionicons
                name="arrow-back"
                size={18}
                color={theme.colors.text}
              />
              <Text
                className="text-[15px] font-semibold text-foreground"
              >
                {router.canGoBack() ? 'Go back' : 'Go home'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}
