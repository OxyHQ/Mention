import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import {
  isLocalCheckoutPreview,
  type CheckoutScenario,
  type PreviewOutcome,
  type CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';
import type {
  MerchantInstallmentPreferences,
  InstallmentPreviewDecision,
} from '@/lib/payments/merchantInstallmentPreview';
import type { PlusCadence } from '@/lib/payments/plusCheckout';
import { LocalCheckoutPreview } from './LocalCheckoutPreview';
/** Development stories only; never imported by the product checkout. */
export function CheckoutFixtureSheet({
  onClose,
  cadence = 'month',
  previewScenario = 'subscription',
  previewOutcome = 'success',
  previewCustomerMode = 'automatic',
  previewSoundEnabled = true,
  previewIncomingFunds = false,
  merchantInstallmentPreferences,
  previewInstallmentDecision = 'available',
}: {
  onClose(): void;
  cadence?: PlusCadence;
  previewScenario?: CheckoutScenario;
  previewOutcome?: PreviewOutcome;
  previewCustomerMode?: CheckoutCustomerMode;
  previewSoundEnabled?: boolean;
  previewIncomingFunds?: boolean;
  merchantInstallmentPreferences?: MerchantInstallmentPreferences;
  previewInstallmentDecision?: InstallmentPreviewDecision;
}) {
  const { user } = useAuth();
  const { activeSessionId } = useOxy();
  if (!isLocalCheckoutPreview()) return null;
  return (
    <LocalCheckoutPreview
      key={`${user?.id}:${activeSessionId}:${cadence}:${previewScenario}:${previewCustomerMode}`}
      customer={
        previewCustomerMode === 'account-preview'
          ? {
              kind: 'account',
              simulated: true,
              displayName: 'Alex Rivera',
              email: 'alex@example.test',
            }
          : previewCustomerMode === 'guest' || !user
            ? { kind: 'guest' }
            : {
                kind: 'account',
                displayName: user.name?.displayName || user.username,
                avatar: user.avatar,
              }
      }
      cadence={cadence}
      scenario={previewScenario}
      outcome={previewOutcome}
      soundEnabled={previewSoundEnabled}
      incomingFunds={previewIncomingFunds}
      merchantInstallmentPreferences={merchantInstallmentPreferences}
      previewInstallmentDecision={previewInstallmentDecision}
      onClose={onClose}
    />
  );
}
