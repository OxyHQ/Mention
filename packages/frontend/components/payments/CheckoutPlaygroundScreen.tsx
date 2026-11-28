import { useState } from 'react';
import { View } from 'react-native';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { Button } from '@oxy.so/bloom/button';
import { CheckoutPreviewControls } from '@/components/payments/CheckoutPreviewControls';
import { CheckoutPreviewBadge } from '@/components/payments/CheckoutPreviewBadge';
import { MerchantInstallmentSettings } from '@/components/payments/MerchantInstallmentSettings';
import { CheckoutFixtureSheet } from '@/components/payments/CheckoutFixtureSheet';
import {
  isLocalCheckoutPreview,
  type CheckoutScenario,
  type PreviewOutcome,
  type CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';
import {
  DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES,
  type InstallmentPreviewDecision,
} from '@/lib/payments/merchantInstallmentPreview';

/** Local developer fixtures only. This route is never a customer checkout mode. */
export default function CheckoutPlayground() {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<CheckoutScenario>('physical');
  const [outcome, setOutcome] = useState<PreviewOutcome>('success');
  const [customerMode, setCustomerMode] = useState<CheckoutCustomerMode>('account-preview');
  const [decision, setDecision] = useState<InstallmentPreviewDecision>('available');
  const [incomingFunds, setIncomingFunds] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [preferences, setPreferences] = useState(DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES);
  if (!isLocalCheckoutPreview()) return <Text>Not available</Text>;
  return (
    <Screen header={<PageHeader />}>
      <ScreenScrollView>
        <View style={{ padding: 24, gap: 20 }}>
          <Text variant="title-2-semibold">Checkout development fixtures</Text>
          <CheckoutPreviewControls
            scenario={scenario}
            onScenario={setScenario}
            outcome={outcome}
            onOutcome={setOutcome}
            customerMode={customerMode}
            onCustomerMode={setCustomerMode}
            installmentDecision={decision}
            onInstallmentDecision={setDecision}
            incomingFunds={incomingFunds}
            onIncomingFunds={setIncomingFunds}
            soundEnabled={soundEnabled}
            onSoundEnabled={setSoundEnabled}
          />
          <MerchantInstallmentSettings value={preferences} onChange={setPreferences} />
          <Button size="lg" onPress={() => setOpen(true)}>
            Open checkout
          </Button>
        </View>
      </ScreenScrollView>
      <CheckoutPreviewBadge />
      {open && (
        <CheckoutFixtureSheet
          cadence="month"
          previewScenario={scenario}
          previewOutcome={outcome}
          previewCustomerMode={customerMode}
          previewInstallmentDecision={decision}
          previewIncomingFunds={incomingFunds}
          previewSoundEnabled={soundEnabled}
          merchantInstallmentPreferences={preferences}
          onClose={() => setOpen(false)}
        />
      )}
    </Screen>
  );
}
