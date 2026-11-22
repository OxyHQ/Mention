import { useState } from 'react';
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
  Group,
  Header,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/** Local developer fixtures only. This route is never a customer checkout mode. */
export default function CheckoutPlayground() {
  if (!isLocalCheckoutPreview()) return toElement(LText('Not available'));
  return <CheckoutPlaygroundScreen />;
}

const CheckoutPlaygroundScreen = screen(function CheckoutPlaygroundScreen() {
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<CheckoutScenario>('physical');
  const [outcome, setOutcome] = useState<PreviewOutcome>('success');
  const [customerMode, setCustomerMode] = useState<CheckoutCustomerMode>('account-preview');
  const [decision, setDecision] = useState<InstallmentPreviewDecision>('available');
  const [incomingFunds, setIncomingFunds] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [preferences, setPreferences] = useState(DEFAULT_MERCHANT_INSTALLMENT_PREFERENCES);
  return Group(
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
    Embed(<CheckoutPreviewBadge />),
    Embed(
      open && (
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
      ),
    ),
  ).header(Header().inPage());
});
