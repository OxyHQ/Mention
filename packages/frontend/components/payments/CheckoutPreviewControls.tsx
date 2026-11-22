import type { InstallmentPreviewDecision } from '@/lib/payments/merchantInstallmentPreview';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type {
  CheckoutScenario,
  PreviewOutcome,
  CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';
import { Button as LButton, Embed, HStack, Text as LText, toElement } from '@oxy.so/bloom-language';

/** Explicit development controls live on the host page, never inside consumer checkout. */
export function CheckoutPreviewControls({
  scenario,
  outcome,
  onScenario,
  onOutcome,
  customerMode,
  onCustomerMode,
  soundEnabled,
  onSoundEnabled,
  incomingFunds,
  onIncomingFunds,
  installmentDecision,
  onInstallmentDecision,
}: {
  installmentDecision: InstallmentPreviewDecision;
  onInstallmentDecision(value: InstallmentPreviewDecision): void;
  incomingFunds: boolean;
  onIncomingFunds(value: boolean): void;
  soundEnabled: boolean;
  onSoundEnabled(value: boolean): void;
  customerMode: CheckoutCustomerMode;
  onCustomerMode(value: CheckoutCustomerMode): void;
  scenario: CheckoutScenario;
  outcome: PreviewOutcome;
  onScenario(value: CheckoutScenario): void;
  onOutcome(value: PreviewOutcome): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View
      style={{
        margin: 24,
        padding: 16,
        gap: 12,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
      }}
    >
      {toElement(LText(t('plus.merchantInstallments.decision.title')))}
      {toElement(
        HStack(
          Embed(
            (['available', 'pending', 'rejected', 'unavailable'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={installmentDecision === value ? 'subtle' : 'outline'}
                onPress={() => onInstallmentDecision(value)}
              >
                {t(`plus.merchantInstallments.decision.${value}`)}
              </Button>
            )),
          ),
        )
          .wrap()
          .spacing('6'),
      )}
      {toElement(
        LButton(LText(t(incomingFunds ? 'plus.checkout.incomingOn' : 'plus.checkout.incomingOff')))
          .size('sm')
          .style('outline')
          .onPress(() => onIncomingFunds(!incomingFunds)),
      )}
      {toElement(
        LButton(LText(t(soundEnabled ? 'plus.checkout.soundOn' : 'plus.checkout.soundOff')))
          .size('sm')
          .style('outline')
          .onPress(() => onSoundEnabled(!soundEnabled)),
      )}
      {toElement(
        HStack(
          Embed(
            (['automatic', 'guest', 'account-preview'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={customerMode === value ? 'subtle' : 'outline'}
                onPress={() => onCustomerMode(value)}
              >
                {t(`plus.checkout.customerMode.${value}`)}
              </Button>
            )),
          ),
        )
          .wrap()
          .spacing('6'),
      )}
      {toElement(
        HStack(
          Embed(
            (['subscription', 'physical', 'trial'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={scenario === value ? 'subtle' : 'outline'}
                onPress={() => onScenario(value)}
              >
                {t(`plus.checkout.scenario.${value}`)}
              </Button>
            )),
          ),
        )
          .wrap()
          .spacing('6'),
      )}
      {toElement(
        HStack(
          Embed(
            (['success', 'failure', 'loading'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={outcome === value ? 'subtle' : 'outline'}
                onPress={() => onOutcome(value)}
              >
                {t(`plus.payment.preview.${value}`)}
              </Button>
            )),
          ),
        )
          .wrap()
          .spacing('6'),
      )}
    </View>
  );
}
