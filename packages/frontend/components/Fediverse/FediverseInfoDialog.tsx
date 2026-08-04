import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Image, type ImageProps } from 'expo-image';
import { Dialog, useDialogControl, useDialogFrame } from '@oxyhq/bloom/dialog';
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

  return (
    <Dialog
      control={control}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      label={t('fediverse.badge.a11yLabel')}
    >
      <FediverseInfoSteps
        step={step}
        showEnableCta={showEnableCta}
        onPrimary={onPrimary}
        onSecondary={onSecondary}
      />
    </Dialog>
  );
}

/**
 * The stepped content, and the declaration of WHICH step is on screen.
 *
 * `useDialogFrame` is why this is its own component rather than JSX inlined
 * above: the frame channel is published by Bloom's `DialogMorphContent`, which
 * wraps the surface's CHILDREN, so a caller that declares the frame from the
 * component rendering `<Dialog>` itself sits outside the provider and the hook
 * quietly no-ops. Advancing a step changes the key while the surface stays
 * open, which is exactly the in-place swap the morph exists for: Bloom animates
 * the panel from the outgoing step's height to the incoming one's (260ms) and
 * fades the incoming content in over a deliberately shorter 150ms, so the new
 * step has landed by the time the panel finishes settling. We declare identity
 * and nothing else — no local height measurement, no opacity shared value, no
 * `entering` animation. Reimplementing any of that here would fight the morph
 * for the same two properties.
 */
function FediverseInfoSteps({
  step,
  showEnableCta,
  onPrimary,
  onSecondary,
}: {
  step: SheetStep;
  showEnableCta: boolean;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const { t } = useTranslation();
  useDialogFrame({ key: `fediverse-info#${step}` });

  const isFirstStep = step === 0;
  const isLastStep = step === 2;
  const primaryLabel = isLastStep
    ? showEnableCta
      ? t('fediverse.sheet.enable')
      : t('fediverse.sheet.done')
    : t('fediverse.sheet.next');
  const secondaryLabel = isFirstStep ? t('fediverse.sheet.cancel') : t('fediverse.sheet.back');

  return (
    <>
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
            step still reads completely with images off.

            No `transition`: the step change is ONE animation and Bloom's dialog
            morph owns it. expo-image's own cross-fade is a second animation over
            the same swap, and it does not run in step with the first — measured
            in a browser, it pushed the new art's first paint from 64ms to 300ms
            after the tap, i.e. past the end of the panel's 260ms reshape, so the
            picture arrived visibly after the words and the panel had already
            finished resizing around it. */}
        <Image
          aria-hidden
          source={STEP_KEYS[step].art}
          className="w-full h-[168px]"
          contentFit="contain"
          alt=""
        />
        <Text className="text-foreground text-xl font-bold text-center">
          {t(STEP_KEYS[step].title)}
        </Text>
        <Text className="text-muted-foreground text-base leading-6 text-center">
          {t(STEP_KEYS[step].body)}
        </Text>
      </View>

      <View className="flex-row items-center justify-center gap-2 py-4">
        {STEP_KEYS.map((entry, index) => (
          <View
            key={entry.title}
            className={
              index === step ? 'w-2 h-2 rounded-full bg-primary' : 'w-2 h-2 rounded-full bg-border'
            }
          />
        ))}
      </View>

      {/* One navigation row: the way back on the left, the way forward on the
          right, matching both the reading order and the direction the progress
          dots advance in.

          The widths are deliberately asymmetric. `Back`/`Cancel` is short in
          every language we ship, while the primary carries the longest label on
          the sheet (`Attiva la condivisione`), so the secondary takes only the
          width of its own text and the primary takes everything left over —
          which puts the free pixels exactly where the overflow risk is. `shrink`
          lets the secondary give way first if even that is not enough.

          These are Bloom Buttons as they come — a variant and a layout class,
          no wrapper element. */}
      <View className="flex-row items-center gap-3">
        <Button variant="ghost" size="large" className="shrink" onPress={onSecondary}>
          {secondaryLabel}
        </Button>
        <Button variant="primary" size="large" className="flex-1" onPress={onPrimary}>
          {primaryLabel}
        </Button>
      </View>
    </>
  );
}
