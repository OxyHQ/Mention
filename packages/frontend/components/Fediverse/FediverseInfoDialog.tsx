import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Image, type ImageProps } from 'expo-image';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { Button } from '@oxyhq/bloom/button';

type SheetStep = 0 | 1 | 2;

/**
 * The three explainer steps, each with the illustration that belongs to it. Kept in
 * ONE table rather than a parallel array of artwork: a step and its picture drifting
 * apart is the failure this shape makes impossible.
 */
const STEP_KEYS: readonly { title: string; body: string; art: ImageProps['source'] }[] = [
  {
    title: 'fediverse.sheet.step1.title',
    body: 'fediverse.sheet.step1.body',
    art: require('@/assets/illustrations/fediverse/fediverse-network.webp'),
  },
  {
    title: 'fediverse.sheet.step2.title',
    body: 'fediverse.sheet.step2.body',
    art: require('@/assets/illustrations/fediverse/fediverse-visibility.webp'),
  },
  {
    title: 'fediverse.sheet.step3.title',
    body: 'fediverse.sheet.step3.body',
    art: require('@/assets/illustrations/fediverse/fediverse-control.webp'),
  },
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
 * many fediverse badge instances a screen renders share ONE dialog rather than
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
        {/* The artwork is transparent line art and sits DIRECTLY on the sheet's
            own surface — no card, plate or fill behind it, in either theme. Each
            file is fitted to one shared canvas by its visible-ink box, so the
            three subjects come out the same size and this slot never changes
            shape as the steps advance.

            `aria-hidden` covers all three platforms in one prop (RN maps it onto
            `accessibilityElementsHidden` and `importantForAccessibility`,
            react-native-web emits the DOM attribute): the art restates the step's
            title and body and adds nothing a screen reader should hear. Every
            step still reads completely with images off. */}
        <Image
          aria-hidden
          source={STEP_KEYS[step].art}
          className="w-full h-[168px]"
          contentFit="contain"
          transition={180}
          alt=""
        />
        <Text className="text-foreground text-xl font-bold text-center">
          {t(STEP_KEYS[step].title)}
        </Text>
        <Text className="text-muted-foreground text-base leading-6 text-center">
          {t(STEP_KEYS[step].body)}
        </Text>
      </View>

      <View className="flex-row items-center justify-center gap-2 py-4">{dots}</View>

      {/* One navigation row: the way back on the left, the way forward on the
          right, matching both the reading order and the direction the progress
          dots advance in.

          The widths are deliberately asymmetric. `Back`/`Cancel` is short in
          every language we ship, while the primary carries the longest label on
          the sheet (`Attiva la condivisione`), so the secondary takes only the
          width of its own text and the primary takes everything left over —
          which puts the free pixels exactly where the overflow risk is. `shrink`
          lets the secondary give way first if even that is not enough.

          Both are wrapped in a plain View because Bloom's native Button renders
          its Pressable inside an unstyled `Animated.View`: `className`/`style` on
          the Button reach the Pressable, so neither can make the outer element
          grow or shrink. (Bloom's web fork renders a real `<button>`, where it
          would work — the wrappers are what make the two platforms agree.) */}
      <View className="flex-row items-center gap-3">
        <View className="shrink">
          <Button variant="ghost" size="large" onPress={onSecondary}>
            {secondaryLabel}
          </Button>
        </View>
        <View className="flex-1">
          <Button variant="primary" size="large" onPress={onPrimary}>
            {primaryLabel}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
