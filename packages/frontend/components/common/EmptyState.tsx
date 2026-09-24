import React, { memo, useCallback, useState, type ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { EmptyState as BloomEmptyState } from '@oxy.so/bloom/empty-state';
import type { BloomIconComponent } from '@oxy.so/bloom';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiAlertLine } from '@oxy.so/bloom/icons/RiAlertLine';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiGalleryLine } from '@oxy.so/bloom/icons/RiGalleryLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { RiNodeTree } from '@oxy.so/bloom/icons/RiNodeTree';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiQuestionLine } from '@oxy.so/bloom/icons/RiQuestionLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiRepeatLine } from '@oxy.so/bloom/icons/RiRepeatLine';
import { RiVolumeMuteLine } from '@oxy.so/bloom/icons/RiVolumeMuteLine';

/**
 * The Ionicons names this component used to draw, and the Bloom glyph each one
 * became. ONE table, deliberately: the call sites keep asking for the name they
 * always asked for, so a substitution that reads wrong is changed in one line
 * here rather than hunted across thirty-four screens — and no test can catch a
 * wrong one, so it has to be reviewable in one place.
 *
 * Three have no like-for-like in Bloom's 461-glyph Remix set and are the ones
 * worth arguing about:
 *
 * - `cloud-offline-outline` -> `RiAlertLine`. There is no cloud-off or wifi-off
 *   glyph. Every call site is a "could not load this" state, so the alert
 *   triangle says the same thing; `RiErrorWarningLine` is kept for the states
 *   that were already spelled `alert-circle-outline`, so the two stay distinct.
 * - `git-branch-outline` -> `RiNodeTree`. Used only by Lanes, whose subject IS a
 *   branching tree of replies.
 * - `bar-chart-outline` -> `RiBarChartHorizontalLine`. Bloom ships no vertical
 *   bar chart glyph.
 */
const ICONS = {
  'add-outline': RiAddLine,
  'alert-circle-outline': RiErrorWarningLine,
  'bar-chart-outline': RiBarChartHorizontalLine,
  'cloud-offline-outline': RiAlertLine,
  'eye-off-outline': RiEyeOffLine,
  'git-branch-outline': RiNodeTree,
  'heart-outline': RiHeartLine,
  'help-circle-outline': RiQuestionLine,
  'images-outline': RiGalleryLine,
  'link-outline': RiLinkM,
  'lock-closed-outline': RiLockLine,
  'notifications-outline': RiNotification3Line,
  'people-outline': RiGroupLine,
  'repeat-outline': RiRepeatLine,
  'volume-mute-outline': RiVolumeMuteLine,
} satisfies Record<string, BloomIconComponent>;

/** The glyph names a call site may ask for. */
export type EmptyStateIconName = keyof typeof ICONS;

export interface EmptyStateProps {
  title?: string;
  subtitle?: string;
  /**
   * `size` is accepted and ignored: Bloom sizes the glyph from `variant`, which
   * is the point of handing the block over. The call sites asked for 44 or 48;
   * the screen rung draws 32.
   */
  icon?: { name: EmptyStateIconName; size?: number };
  /** An error with a retry. The retrying state is this component's to hold. */
  error?: { title: string; message: string; onRetry?: () => Promise<void> };
  action?: { label: string; onPress: () => void; icon?: EmptyStateIconName };
  /** An arbitrary mark above the title. Wins over `icon`, as Bloom's does. */
  customIcon?: ReactNode;
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
 * is only what is Mention's: the glyph vocabulary above, and the error/retry
 * pair, which Bloom models as an action with a `loading` flag rather than as a
 * mode of its own.
 */
export const EmptyState = memo<EmptyStateProps>(function EmptyState({
  title,
  subtitle,
  icon,
  error,
  action,
  customIcon,
  containerStyle,
  testID,
}) {
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

  const glyph = icon ? ICONS[icon.name] : undefined;

  if (error) {
    return (
      <BloomEmptyState
        // No glyph means NO disc, which is the point: a transient backend
        // hiccup reads as a calm retry, and the tinted alarm disc is reserved
        // for the one failure a reader can act on. A production incident put
        // that disc in front of every reader during a blip; the guard is
        // `components/Feed/__tests__/feedEmptyState.test.tsx`.
        icon={glyph}
        media={glyph ? 'circle' : undefined}
        title={error.title}
        description={error.message}
        action={
          onRetry
            ? { label: 'Try again', onPress: handleRetry, icon: RiRefreshLine, loading: isRetrying }
            : undefined
        }
        style={containerStyle}
        testID={testID}
      />
    );
  }

  // The old component rendered nothing at all with no title, no subtitle and no
  // glyph. Bloom would draw an empty block, so the guard stays.
  if (!title && !subtitle && !customIcon && !icon) return null;

  return (
    <BloomEmptyState
      icon={glyph}
      illustration={customIcon}
      title={title}
      description={subtitle}
      action={
        action
          ? { label: action.label, onPress: action.onPress, icon: action.icon ? ICONS[action.icon] : undefined }
          : undefined
      }
      style={containerStyle}
      testID={testID}
    />
  );
});
