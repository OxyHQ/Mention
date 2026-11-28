// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { View } from 'react-native';
import { Portal } from '@oxy.so/bloom/portal';
import { OverlayRoot, TOAST_LAYER_Z } from '@oxy.so/bloom/overlay';
import { Badge } from '@oxy.so/bloom/badge';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

/** A noninteractive host-only disclosure. It never becomes a modal or owns dismissal. */
export function CheckoutPreviewBadge({ providerTest = false }: { providerTest?: boolean }) {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <Portal>
      <OverlayRoot zIndex={TOAST_LAYER_Z}>
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, right: 16 }}>
          <Badge
            testID="checkout-local-preview-badge"
            content={t(
              providerTest ? 'plus.checkout.providerTest.badge' : 'plus.checkout.localPreview',
            )}
            size="label-small"
          />
        </View>
      </OverlayRoot>
    </Portal>
  );
}
