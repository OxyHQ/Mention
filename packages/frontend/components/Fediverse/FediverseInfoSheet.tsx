import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxyhq/bloom/button';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';

type SheetStep = 0 | 1 | 2;

const STEP_KEYS: readonly { title: string; body: string }[] = [
  { title: 'fediverse.sheet.step1.title', body: 'fediverse.sheet.step1.body' },
  { title: 'fediverse.sheet.step2.title', body: 'fediverse.sheet.step2.body' },
  { title: 'fediverse.sheet.step3.title', body: 'fediverse.sheet.step3.body' },
];

interface FediverseInfoSheetProps {
  /** Dismisses the sheet — wired to the shared BottomSheetContext by the opener. */
  onClose: () => void;
  /** Step to open on (0-based). Defaults to the first step. */
  initialStep?: SheetStep;
  /**
   * When true, the final step's primary action reads "Turn on sharing" and runs
   * `onEnable` before closing (used when the viewer's sharing is currently off),
   * instead of simply dismissing.
   */
  showEnableCta?: boolean;
  /** Runs the enable flow when the final-step CTA is pressed (with showEnableCta). */
  onEnable?: () => void;
}

/**
 * Threads-style educational bottom sheet explaining fediverse sharing across
 * three steps (what it is, how sharing works, staying in control). A dumb
 * presentational component: it owns only its local step index and calls back to
 * the opener for dismissal and the optional enable flow, so it is reusable from
 * both the profile `FediverseBadge` and the settings screen.
 */
export function FediverseInfoSheet({
  onClose,
  initialStep = 0,
  showEnableCta = false,
  onEnable,
}: FediverseInfoSheetProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<SheetStep>(initialStep);

  const isFirstStep = step === 0;
  const isLastStep = step === 2;

  const onPrimary = () => {
    if (!isLastStep) {
      setStep((step + 1) as SheetStep);
      return;
    }
    if (showEnableCta) {
      onEnable?.();
    }
    onClose();
  };

  const onSecondary = () => {
    if (isFirstStep) {
      onClose();
      return;
    }
    setStep((step - 1) as SheetStep);
  };

  const primaryLabel = isLastStep
    ? showEnableCta
      ? t('fediverse.sheet.enable')
      : t('fediverse.sheet.done')
    : t('fediverse.sheet.next');
  const secondaryLabel = isFirstStep ? t('fediverse.sheet.cancel') : t('fediverse.sheet.back');

  return (
    <View className="bg-background px-5 pt-4 pb-3">
      <View className="items-center gap-4 py-4">
        <View className="w-20 h-20 rounded-full bg-primary/10 items-center justify-center">
          <FediverseIcon size={40} className="text-primary" />
        </View>
        <Text className="text-foreground text-xl font-bold text-center">
          {t(STEP_KEYS[step].title)}
        </Text>
        <Text className="text-muted-foreground text-base leading-6 text-center">
          {t(STEP_KEYS[step].body)}
        </Text>
      </View>

      <View className="flex-row items-center justify-center gap-2 py-4">
        {STEP_KEYS.map((_, index) => (
          <View
            key={index}
            className={index === step ? 'w-2 h-2 rounded-full bg-primary' : 'w-2 h-2 rounded-full bg-border'}
          />
        ))}
      </View>

      <View className="gap-3">
        <Button variant="primary" size="large" onPress={onPrimary}>
          {primaryLabel}
        </Button>
        <Button variant="ghost" size="large" onPress={onSecondary}>
          {secondaryLabel}
        </Button>
      </View>
    </View>
  );
}
