import { View } from 'react-native';
import { Portal } from '@oxy.so/bloom/portal';
import { OverlayRoot, TOAST_LAYER_Z } from '@oxy.so/bloom/overlay';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Badge as LBadge, toElement } from '@oxy.so/bloom-language';

/** A noninteractive host-only disclosure. It never becomes a modal or owns dismissal. */
export function CheckoutPreviewBadge({ providerTest = false }: { providerTest?: boolean }) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <Portal>
      <OverlayRoot zIndex={TOAST_LAYER_Z}>
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, right: 16 }}>
          {toElement(
            LBadge(
              t(providerTest ? 'plus.checkout.providerTest.badge' : 'plus.checkout.localPreview'),
            )
              .testID('checkout-local-preview-badge')
              .size('label-small'),
          )}
        </View>
      </OverlayRoot>
    </Portal>
  );
}
