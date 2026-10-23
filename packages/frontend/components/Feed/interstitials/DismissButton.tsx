import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { cn } from '@/lib/utils';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

interface DismissButtonProps {
  onPress: () => void;
  /** Accessible name — what this dismisses ("Dismiss @nate"), not just "Dismiss". */
  accessibilityLabel: string;
  /** Lift the button over a card it overlays (the starter-pack card has no slot). */
  overlay?: boolean;
}

/**
 * The X on a suggestion. Dismissal is in-memory for the life of the feed — a
 * refresh brings the suggestion back — so this never talks to the backend; the
 * band that owns it holds the dismissed ids.
 *
 * A TouchableOpacity (not a Bloom `Button`) on purpose: some of these sit INSIDE
 * a pressable card, and only RN's responder system lets the inner control win
 * the press. A real DOM button would bubble its click and navigate away.
 */
export function DismissButton({
  onPress,
  accessibilityLabel,
  overlay = false,
}: DismissButtonProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      hitSlop={HIT_SLOP_MD}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t('feed.interstitial.dismissHint')}
      className={cn(
        'h-6 w-6 items-center justify-center rounded-full',
        overlay && 'absolute right-2 top-2 z-10 bg-background/80',
      )}
    >
      <RiCloseLine width={14} height={14} fill={colors.textSecondary} />
    </TouchableOpacity>
  );
}
