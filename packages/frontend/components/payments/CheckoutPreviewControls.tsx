import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type {
  CheckoutScenario,
  PreviewOutcome,
  CheckoutCustomerMode,
} from '@/lib/payments/checkoutPreview';

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
}: {
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
      <Button size="sm" appearance="outline" onPress={() => onIncomingFunds(!incomingFunds)}>
        {t(incomingFunds ? 'plus.checkout.incomingOn' : 'plus.checkout.incomingOff')}
      </Button>
      <Button size="sm" appearance="outline" onPress={() => onSoundEnabled(!soundEnabled)}>
        {t(soundEnabled ? 'plus.checkout.soundOn' : 'plus.checkout.soundOff')}
      </Button>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(['automatic', 'guest', 'account-preview'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            appearance={customerMode === value ? 'subtle' : 'outline'}
            onPress={() => onCustomerMode(value)}
          >
            {t(`plus.checkout.customerMode.${value}`)}
          </Button>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(['subscription', 'physical', 'trial'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            appearance={scenario === value ? 'subtle' : 'outline'}
            onPress={() => onScenario(value)}
          >
            {t(`plus.checkout.scenario.${value}`)}
          </Button>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(['success', 'failure', 'loading'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            appearance={outcome === value ? 'subtle' : 'outline'}
            onPress={() => onOutcome(value)}
          >
            {t(`plus.payment.preview.${value}`)}
          </Button>
        ))}
      </View>
    </View>
  );
}
