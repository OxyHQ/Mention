import { useState } from 'react';
import { Screen } from '@oxy.so/bloom/screen';
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

import {
  Button as LButton,
  Embed,
  Header,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
  if (!isLocalCheckoutPreview()) return toElement(LText('Not available'));
  return (
    <Screen header={toElement(Header().inPage())}>
      {toElement(
        ScrollView(
          VStack(
            LText('Checkout development fixtures').font('title-2').weight('semibold'),
            Embed(
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
              />,
            ),
            Embed(<MerchantInstallmentSettings value={preferences} onChange={setPreferences} />),
            LButton(LText('Open checkout'))
              .size('lg')
              .onPress(() => setOpen(true)),
          )
            .padding('all', '2xl')
            .spacing('xl'),
        ),
      )}
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
