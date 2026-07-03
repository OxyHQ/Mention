import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { Button } from '@oxyhq/bloom/button';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';

type SheetStep = 0 | 1 | 2;

const STEP_KEYS: readonly { title: string; body: string }[] = [
  { title: 'fediverse.sheet.step1.title', body: 'fediverse.sheet.step1.body' },
  { title: 'fediverse.sheet.step2.title', body: 'fediverse.sheet.step2.body' },
  { title: 'fediverse.sheet.step3.title', body: 'fediverse.sheet.step3.body' },
];

export interface FediverseInfoOptions {
  /**
   * When true, the final step's primary action reads "Turn on sharing" and runs
   * `onEnable` before closing (used when the viewer's sharing is currently off),
   * instead of simply dismissing.
   */
  showEnableCta?: boolean;
  /** Runs the enable flow when the final-step CTA is pressed (with showEnableCta). */
  onEnable?: () => void;
}

let globalShowFediverseInfo: ((options: FediverseInfoOptions) => void) | null = null;

/**
 * Open the Threads-style educational fediverse flow from anywhere. Routed to the
 * single `FediverseInfoDialogProvider` host mounted in the providers tree, so the
 * many `FediverseBadge` instances a screen renders share ONE dialog rather than
 * each mounting their own. No-ops if the host isn't mounted yet.
 */
export function showFediverseInfo(options: FediverseInfoOptions = {}) {
  globalShowFediverseInfo?.(options);
}

/**
 * Single global host for the fediverse educational flow. Presents Bloom's
 * adaptive `Dialog` — a bottom-sheet on narrow viewports, a centered card on
 * desktop — and steps through the three explainer cards (what it is, how sharing
 * works, staying in control). Owns the step index and the current request; the
 * badge and settings screen drive it through `showFediverseInfo`.
 *
 * Mount once near the app root (see `AppProviders`).
 */
export function FediverseInfoDialogProvider() {
  const { t } = useTranslation();
  const control = useDialogControl();
  const [options, setOptions] = useState<FediverseInfoOptions | null>(null);
  const [step, setStep] = useState<SheetStep>(0);

  useEffect(() => {
    globalShowFediverseInfo = (opts) => {
      setOptions(opts);
      setStep(0);
      // Open on the next tick so the Dialog mounts with the fresh request first.
      setTimeout(() => control.open(), 0);
    };
    return () => {
      globalShowFediverseInfo = null;
    };
  }, [control]);

  const handleClose = useCallback(() => {
    setOptions(null);
  }, []);

  const isFirstStep = step === 0;
  const isLastStep = step === 2;
  const showEnableCta = options?.showEnableCta ?? false;

  const onPrimary = useCallback(() => {
    if (!isLastStep) {
      setStep((current) => (current + 1) as SheetStep);
      return;
    }
    if (showEnableCta) {
      options?.onEnable?.();
    }
    control.close();
  }, [control, isLastStep, options, showEnableCta]);

  const onSecondary = useCallback(() => {
    if (isFirstStep) {
      control.close();
      return;
    }
    setStep((current) => (current - 1) as SheetStep);
  }, [control, isFirstStep]);

  const primaryLabel = isLastStep
    ? showEnableCta
      ? t('fediverse.sheet.enable')
      : t('fediverse.sheet.done')
    : t('fediverse.sheet.next');
  const secondaryLabel = isFirstStep ? t('fediverse.sheet.cancel') : t('fediverse.sheet.back');

  const dots = useMemo(
    () =>
      STEP_KEYS.map((_, index) => (
        <View
          key={index}
          className={
            index === step ? 'w-2 h-2 rounded-full bg-primary' : 'w-2 h-2 rounded-full bg-border'
          }
        />
      )),
    [step],
  );

  return (
    <Dialog
      control={control}
      onClose={handleClose}
      placement={{ base: 'bottom', md: 'center' }}
      label={t('fediverse.badge.a11yLabel')}
    >
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

      <View className="flex-row items-center justify-center gap-2 py-4">{dots}</View>

      <View className="gap-3">
        <Button variant="primary" size="large" onPress={onPrimary}>
          {primaryLabel}
        </Button>
        <Button variant="ghost" size="large" onPress={onSecondary}>
          {secondaryLabel}
        </Button>
      </View>
    </Dialog>
  );
}
