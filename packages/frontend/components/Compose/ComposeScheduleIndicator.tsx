import { memo } from 'react';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { formatTimeAgo } from '@/utils/dateUtils';

interface ComposeScheduleIndicatorProps {
  /**
   * The chosen publish time, already formatted SHORT by the composer, or `null`
   * while the post goes out immediately.
   *
   * Formatted by the caller rather than here: the same instant is also spelled
   * out in the footer pill and in the "Scheduled for …" toast, and a component
   * that formatted its own would be a second decision free to drift from those.
   */
  scheduledLabel: string | null;
  /** Opens the schedule picker, which is also where clearing the time lives. */
  onPress: () => void;
  disabled?: boolean;
}

/**
 * The composer's answer to "when does this go out", rendered in the author row's
 * time slot — the spot a published post fills with its relative time and an
 * unpublished one fills with "now".
 *
 * TWO things about it are load-bearing and neither is obvious from the render:
 *
 * **It is present in BOTH states, and pressable in both.** It used to be
 * rendered only once a time had been picked, so the initial row showed a plain,
 * dead "now" and the only way to schedule a post for the first time was a
 * separate button — while an ALREADY-scheduled post could be changed by tapping
 * the row. That asymmetry is exactly backwards: the row that says when the post
 * goes out is the obvious place to say it differently. Owning the unscheduled
 * word here, instead of letting `PostHeader` fall back to its own label, is what
 * makes the slot pressable without touching the header a published post shares.
 *
 * **It looks like the word it replaces.** Not `text-primary`, not semibold, and
 * no "Scheduled" prefix: the slot is a quiet fact on the identity line, and a
 * tinted bold phrase there reads as a badge the post does not have. The STATE
 * still has to reach a screen reader, which has no tint and no context to infer
 * it from — so the accessibility label says it in full even though the visible
 * text is just the date. That is a deliberate asymmetry, not an oversight.
 */
const ComposeScheduleIndicator = memo<ComposeScheduleIndicatorProps>(({
  scheduledLabel,
  onPress,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const haptic = useHaptics();

  return (
    <PressableScale
      onPress={() => {
        haptic('light');
        onPress();
      }}
      disabled={disabled}
      // `flex-shrink-0` keeps the time whole: the identity line lets the
      // `@handle` give way first (it carries `flexShrink: 10`), which is the
      // right trade here since the composer shows the viewer their OWN handle
      // and the publish time is the part they do not already know.
      className="flex-shrink-0"
      accessibilityRole="button"
      // The label carries the STATE, not just the action — the visible text is
      // now only a date, so this is the only place a screen reader learns the
      // post is scheduled at all.
      accessibilityLabel={scheduledLabel
        ? t('compose.schedule.chipA11y', {
            defaultValue: 'Scheduled for {{time}}. Tap to change.',
            time: scheduledLabel,
          })
        : t('compose.schedule.a11y', { defaultValue: 'Schedule this post' })}
    >
      {/* The SAME classes `PostHeader` gives the label this stands in for, so
          the row does not change shape when a time is picked. Never a
          hand-built `${theme.colors.primary}1A`: the accent roles resolve to
          `rgb(...)`, so appending hex alpha yields a string react-native-web
          reads back as FULLY OPAQUE. */}
      <Text
        className="text-muted-foreground text-[15px] leading-tight web:whitespace-nowrap"
        style={{ opacity: disabled ? 0.5 : 1 }}
      >
        {/* Read from the same helper `PostHeader` uses for a dateless row, so
            the unscheduled word here and the one a box would otherwise show
            cannot drift apart. */}
        {'·'} {scheduledLabel ?? formatTimeAgo('')}
      </Text>
    </PressableScale>
  );
});

ComposeScheduleIndicator.displayName = 'ComposeScheduleIndicator';

export default ComposeScheduleIndicator;
