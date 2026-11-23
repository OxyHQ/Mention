import { useTranslation } from 'react-i18next';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';

import { Icon, toElement, VStack } from '@oxy.so/bloom-language';

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
 * A TouchableOpacity (`.pressFade()`, not a Bloom `Button`) on purpose: some of these sit INSIDE
 * a pressable card, and only RN's responder system lets the inner control win
 * the press. A real DOM button would bubble its click and navigate away.
 */
export function DismissButton({
  onPress,
  accessibilityLabel,
  overlay = false,
}: DismissButtonProps) {
  const { t } = useTranslation();

  // It dims under the finger (`.pressFade()`); over a card it floats in the corner on a veil.
  return toElement(
    VStack(Icon(RiCloseLine).size('14').foreground('muted'))
      .frame({ width: '2xl', height: '2xl' })
      .align('center')
      .justify('center')
      .corner('infinite')
      .when(overlay, (v) =>
        v.position({ top: 'sm', right: 'sm' }).zIndex('floating').background('background/80'),
      )
      .onPress(onPress)
      .pressFade('60')
      .hitSlop('md')
      .role('button')
      .label(accessibilityLabel)
      .hint(t('feed.interstitial.dismissHint')),
  );
}
