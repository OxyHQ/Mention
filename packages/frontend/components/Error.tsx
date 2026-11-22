import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { useContentSafeAreaInsets } from '@oxy.so/bloom/layout';
import { EmptyState } from '@/components/common/EmptyState';
import { Button as LButton, Icon, Text, toElement } from '@oxy.so/bloom-language';

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
  const insets = useContentSafeAreaInsets();

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
      style={[
        styles.screen,
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 },
        style,
      ]}
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
          hideBackButton
            ? undefined
            : toElement(
                LButton(Icon(RiArrowLeftLine), Text(router.canGoBack() ? 'Go back' : 'Go home'))
                  .style('subtle')
                  .tint('neutral')
                  .onPress(handleGoBack),
              )
        }
      />
    </View>
  );
}

// The screen's frame keeps React Native's view: its vertical padding adds the
// safe area's insets, a runtime value no space token holds.
const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
});
