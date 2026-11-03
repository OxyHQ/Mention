import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { CheckoutScenario, PreviewOutcome } from '@/lib/payments/checkoutFlow';

/** Explicit development controls live on the host page, never inside consumer checkout. */
export function CheckoutPreviewControls({
  scenario,
  outcome,
  onScenario,
  onOutcome,
}: {
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
      <Text style={{ color: colors.textSecondary, fontSize: 12 }}>
        {t('plus.payment.previewLabel')}
      </Text>
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
