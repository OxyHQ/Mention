import { memo } from 'react';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { useHaptics } from '@oxyhq/bloom/hooks';

interface ComposeScheduleIndicatorProps {
  /** The chosen publish time, already formatted for display. */
  scheduledLabel: string;
  /** Reopens the schedule picker, which is also where clearing the time lives. */
  onPress: () => void;
  disabled?: boolean;
}

/**
 * The composer's answer to "when does this post go out", rendered in the author
 * row's time slot — the spot that reads "now" until a time is picked.
 *
 * It replaces that word rather than sitting beside it: one line saying either
 * "now" or "Scheduled <time>" is the whole state, so there is no card and no
 * chip elsewhere restating it. Tapping reopens the picker, because a time you
 * can see and cannot change is worse than one you cannot see.
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
      // The label carries the STATE, not just the action — a screen reader has
      // no tint to read, and this row is now the only place the time appears.
      accessibilityLabel={t('compose.schedule.chipA11y', {
        defaultValue: 'Scheduled for {{time}}. Tap to change.',
        time: scheduledLabel,
      })}
    >
      {/* Tinted `text-primary`, never a hand-built `${theme.colors.primary}1A`:
          the accent roles resolve to `rgb(...)`, so appending hex alpha yields a
          string react-native-web reads back as FULLY OPAQUE. */}
      <Text
        className="text-primary text-[15px] font-semibold leading-tight web:whitespace-nowrap"
        style={{ opacity: disabled ? 0.5 : 1 }}
      >
        {'·'} {t('compose.schedule.headerIndicator', {
          defaultValue: 'Scheduled {{time}}',
          time: scheduledLabel,
        })}
      </Text>
    </PressableScale>
  );
});

ComposeScheduleIndicator.displayName = 'ComposeScheduleIndicator';

export default ComposeScheduleIndicator;
