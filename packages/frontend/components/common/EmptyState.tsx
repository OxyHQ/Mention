import { memo, useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ViewStyle } from 'react-native';
import { EmptyState as BloomEmptyState, type EmptyStateAction } from '@oxy.so/bloom/empty-state';
import type { BloomIconComponent } from '@oxy.so/bloom';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import type { EmptyStateStickerName } from '@/lib/stickers';
import { EmptyStateSticker } from '@/components/common/EmptyStateSticker';

export interface EmptyStateProps {
  title?: string;
  subtitle?: string;
  /** The Bloom glyph above the title. Bloom sizes it; an error draws a sticker instead. */
  icon?: BloomIconComponent;
  /** An error with a retry. The retrying state is this component's to hold. */
  error?: { title: string; message: string; onRetry?: () => Promise<void> };
  action?: EmptyStateAction;
  /** An arbitrary mark above the title. Wins over `icon`, as Bloom's does. */
  customIcon?: ReactNode;
  /**
   * A sticker from Oxy's catalogue above the title, by its name in
   * `lib/stickers.ts`. Wins over `icon` (Bloom's `illustration` does). With
   * `error` it defaults to `loadError`; a connection failure passes `offline`.
   */
  sticker?: EmptyStateStickerName;
  /** Below the action — a second, quieter way out (Bloom's `footer`). */
  footer?: ReactNode;
  containerStyle?: ViewStyle;
  testID?: string;
}

/**
 * Mention's empty and error states, drawn by Bloom.
 *
 * This used to hand-roll the block — a 72px disc, its own type ramp, its own
 * spacing, `accessibilityRole="text"` on a container holding three strings —
 * which is the shape `@oxy.so/bloom/empty-state` was added to replace across
 * the twelve Bloom families that had each drawn their own. What survives here
 * is only what is Mention's: the catalogue stickers, and the error/retry pair,
 * which Bloom models as an action with a `loading` flag rather than as a mode
 * of its own.
 */
export const EmptyState = memo<EmptyStateProps>(function EmptyState({
  title,
  subtitle,
  icon,
  error,
  action,
  customIcon,
  sticker,
  footer,
  containerStyle,
  testID,
}) {
  const { t } = useTranslation();
  const [isRetrying, setIsRetrying] = useState(false);
  const onRetry = error?.onRetry;

  const handleRetry = useCallback(async () => {
    if (!onRetry || isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry, isRetrying]);

  if (error) {
    // Every failure gets a sticker: "could not load" unless the call site names
    // its own (`offline` for a connection failure). The tinted alarm disc stays
    // retired — a sticker is not an alarm, and a transient backend hiccup must
    // still read as a calm retry.
    return (
      <BloomEmptyState
        illustration={customIcon ?? <EmptyStateSticker name={sticker ?? 'loadError'} />}
        title={error.title}
        description={error.message}
        action={
          onRetry
            ? {
                label: t('common.retry', { defaultValue: 'Try again' }),
                onPress: handleRetry,
                icon: RiRefreshLine,
                loading: isRetrying,
              }
            : undefined
        }
        footer={footer}
        style={containerStyle}
        testID={testID}
      />
    );
  }

  if (!title && !subtitle && !customIcon && !icon && !sticker) return null;

  const illustration = customIcon ?? (sticker ? <EmptyStateSticker name={sticker} /> : undefined);

  return (
    <BloomEmptyState
      icon={icon}
      illustration={illustration}
      footer={footer}
      title={title}
      description={subtitle}
      action={action}
      style={containerStyle}
      testID={testID}
    />
  );
});
