import { tokens } from '@oxy.so/bloom/styles';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

import { Icon, toElement } from '@oxy.so/bloom-language';

// A touchable (it dims under the finger, which the language's press variant has
// no timed opacity for); over a card it floats in the corner on a veil.
const useButtonStyles = createTokenStyles((t) => ({
  button: {
    height: 24,
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Number.MAX_SAFE_INTEGER,
  },
  overlay: {
    position: 'absolute',
    right: 8,
    top: 8,
    zIndex: 10,
    backgroundColor: tokenAlpha(t.background, 0.8),
  },
}));

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
  const styles = useButtonStyles();
  const { t } = useTranslation();

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      hitSlop={tokens.hitSlop.md}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={t('feed.interstitial.dismissHint')}
      style={[styles.button, overlay && styles.overlay]}
    >
      {toElement(Icon(RiCloseLine).size('14').foreground('muted'))}
    </TouchableOpacity>
  );
}
