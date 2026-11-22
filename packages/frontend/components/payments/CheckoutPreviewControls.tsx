import type { InstallmentPreviewDecision } from '@/lib/payments/merchantInstallmentPreview';
import { useTranslation } from 'react-i18next';
import type {
  CheckoutScenario,
  PreviewOutcome,
  CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';
import {
  Button as LButton,
  HStack,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
  // One row of choices: the chosen one subtle, the others outlined.
  const choices = <T extends string>(
    values: readonly T[],
    chosen: T,
    choose: (value: T) => void,
    label: (value: T) => string,
  ) =>
    HStack(
      values.map((value) =>
        LButton(LText(label(value)))
          .size('sm')
          .style(chosen === value ? 'subtle' : 'outline')
          .onPress(() => choose(value))
          .id(value),
      ),
    )
      .wrap()
      .spacing('6');
  return toElement(
    VStack(
      LText(t('plus.merchantInstallments.decision.title')),
      choices(
        ['available', 'pending', 'rejected', 'unavailable'] as const,
        installmentDecision,
        onInstallmentDecision,
        (value) => t(`plus.merchantInstallments.decision.${value}`),
      ),
      LButton(LText(t(incomingFunds ? 'plus.checkout.incomingOn' : 'plus.checkout.incomingOff')))
        .size('sm')
        .style('outline')
        .onPress(() => onIncomingFunds(!incomingFunds)),
      LButton(LText(t(soundEnabled ? 'plus.checkout.soundOn' : 'plus.checkout.soundOff')))
        .size('sm')
        .style('outline')
        .onPress(() => onSoundEnabled(!soundEnabled)),
      choices(
        ['automatic', 'guest', 'account-preview'] as const,
        customerMode,
        onCustomerMode,
        (value) => t(`plus.checkout.customerMode.${value}`),
      ),
      choices(['subscription', 'physical', 'trial'] as const, scenario, onScenario, (value) =>
        t(`plus.checkout.scenario.${value}`),
      ),
      choices(['success', 'failure', 'loading'] as const, outcome, onOutcome, (value) =>
        t(`plus.payment.preview.${value}`),
      ),
    )
      .margin('all', '2xl')
      .padding('all', 'lg')
      .spacing('md')
      .border('border', 'thin')
      .corner('lg'),
  );
}
