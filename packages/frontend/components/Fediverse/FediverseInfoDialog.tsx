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
 * Single global host for the fediverse educational flow. Mount once near the app
 * root (see `AppProviders`).
 *
 * BOOT-SAFETY (critical): this host is mounted eagerly at app boot — before the
 * async i18n init effect in `RootLayout` has run. It must therefore NOT call any
 * suspenseful hook (notably `useTranslation`, which throws a promise while
 * react-i18next is still initializing under its default `useSuspense: true`). A
 * suspend here would discard the root render, so the i18n-init effect never
 * commits, its promise never resolves, and the whole app deadlocks on a blank
 * screen with no error. So the host owns ONLY the request store and renders
 * NOTHING until `showFediverseInfo` is called — which also defers the Dialog's
 * reanimated bottom-sheet, so nothing heavy mounts at boot. All translation- and
 * dialog-dependent UI lives in `FediverseInfoDialogContent`, mounted on demand,
 * by which point i18n is long ready.
 */
export function FediverseInfoDialogProvider() {
  const [options, setOptions] = useState<FediverseInfoOptions | null>(null);

  useEffect(() => {
    globalShowFediverseInfo = (opts) => {
      setOptions(opts);
    };
    return () => {
      globalShowFediverseInfo = null;
    };
  }, []);

  const handleClose = useCallback(() => {
    setOptions(null);
  }, []);

  // No pending request → render nothing. Crucially this returns BEFORE any
  // suspenseful hook exists in this component, keeping app boot safe.
  if (!options) return null;

  return <FediverseInfoDialogContent options={options} onClose={handleClose} />;
}

/**
 * The educational flow's actual UI: Bloom's adaptive `Dialog` — a bottom-sheet on
 * narrow viewports, a centered card on desktop — stepping through the three
 * explainer cards (what it is, how sharing works, staying in control). Mounted
 * ONLY once a request exists, so `useTranslation` here is always safe (i18n is
 * initialized well before any badge/settings tap).
 *
 * It owns its own `control` and OPENS ITSELF on mount: the Dialog's imperative
 * handle binds `control` during the commit's layout phase, before this passive
 * mount effect runs, so `control.open()` always reaches a bound handle — no
 * `setTimeout` and no dependency on how the request was triggered (badge tap,
 * settings button, or a programmatic call).
 */
function FediverseInfoDialogContent({
  options,
  onClose,
}: {
  options: FediverseInfoOptions;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const control = useDialogControl();
  const [step, setStep] = useState<SheetStep>(0);

  useEffect(() => {
    control.open();
  }, [control]);

  const isFirstStep = step === 0;
  const isLastStep = step === 2;
  const showEnableCta = options.showEnableCta ?? false;

  const onPrimary = useCallback(() => {
    if (!isLastStep) {
      setStep((current) => (current + 1) as SheetStep);
      return;
    }
    if (showEnableCta) {
      options.onEnable?.();
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
      onClose={onClose}
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
