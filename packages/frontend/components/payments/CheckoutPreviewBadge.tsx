import { Portal } from '@oxy.so/bloom/portal';
import { OverlayRoot, TOAST_LAYER_Z } from '@oxy.so/bloom/overlay';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Badge as LBadge, toElement, Embed, VStack } from '@oxy.so/bloom-language';

/** A noninteractive host-only disclosure. It never becomes a modal or owns dismissal. */
export function CheckoutPreviewBadge({ providerTest = false }: { providerTest?: boolean }) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <Portal>
      <OverlayRoot zIndex={TOAST_LAYER_Z}>
        {toElement(
          VStack(
            LBadge(
              t(providerTest ? 'plus.checkout.providerTest.badge' : 'plus.checkout.localPreview'),
            )
              .testID('checkout-local-preview-badge')
              .size('label-small'),
          )
            .position({ right: 'lg', top: insets.top + 8 })
            .allowsHitTesting(false),
        )}
      </OverlayRoot>
    </Portal>
  );
}
