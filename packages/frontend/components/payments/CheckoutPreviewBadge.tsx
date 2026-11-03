import { View } from 'react-native';
import { Portal } from '@oxy.so/bloom/portal';
import { OverlayRoot, TOAST_LAYER_Z } from '@oxy.so/bloom/overlay';
import { Badge } from '@oxy.so/bloom/badge';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

/** A noninteractive host-only disclosure. It never becomes a modal or owns dismissal. */
export function CheckoutPreviewBadge() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <Portal>
      <OverlayRoot zIndex={TOAST_LAYER_Z}>
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, right: 16 }}>
          <Badge
            testID="checkout-local-preview-badge"
            content={t('plus.checkout.localPreview')}
            size="label-small"
          />
        </View>
      </OverlayRoot>
    </Portal>
  );
}
