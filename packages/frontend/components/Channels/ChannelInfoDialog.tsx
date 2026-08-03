import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Dialog, useDialogControl } from '@oxyhq/bloom/dialog';
import { Button } from '@oxyhq/bloom/button';
import { ChannelIcon } from '@/assets/icons/channel-icon';

type ExplainerStep = 0 | 1 | 2;

/**
 * The three facts a reader actually needs, in the order the questions arrive:
 * what following one commits you to, why there is no reply box, and whose words
 * these are. Deliberately not a feature list — every step names something the
 * reader can observe on the page behind the dialog.
 */
const STEP_KEYS: readonly { title: string; body: string }[] = [
  { title: 'channels.explainer.step1.title', body: 'channels.explainer.step1.body' },
  { title: 'channels.explainer.step2.title', body: 'channels.explainer.step2.body' },
  { title: 'channels.explainer.step3.title', body: 'channels.explainer.step3.body' },
];

let globalShowChannelInfo: (() => void) | null = null;

/**
 * Open the channel explainer. Routed to the single `ChannelInfoDialogProvider`
 * host in the providers tree rather than mounted beside the marker that asks for
 * it, so the dialog outlives the header's own render and there is one instance
 * however many markers a screen draws. No-ops if the host isn't mounted yet.
 */
export function showChannelInfo() {
  globalShowChannelInfo?.();
}

/**
 * Single global host for the channel explainer. Mount once near the app root
 * (see `AppProviders`).
 *
 * BOOT-SAFETY (critical, and the reason this host looks emptier than it should):
 * it is mounted eagerly at app boot — before the async i18n init effect in
 * `RootLayout` has run — so it must NOT call any suspenseful hook. `useTranslation`
 * is one: under react-i18next's default `useSuspense: true` it throws a promise
 * while i18n is still initializing, which would discard the root render, so the
 * init effect never commits, its promise never resolves, and the app deadlocks on
 * a blank screen with no error at all. This host therefore owns ONLY the open
 * flag and renders NOTHING until `showChannelInfo` is called — which also keeps
 * the Dialog's reanimated bottom-sheet out of the boot path. Every translated or
 * dialog-dependent piece lives in `ChannelInfoDialogContent`, mounted on demand,
 * by which point i18n is long ready.
 */
export function ChannelInfoDialogProvider() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    globalShowChannelInfo = () => {
      setIsOpen(true);
    };
    return () => {
      globalShowChannelInfo = null;
    };
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Nothing requested → render nothing. Crucially this returns BEFORE any
  // suspenseful hook exists in this component, keeping app boot safe.
  if (!isOpen) return null;

  return <ChannelInfoDialogContent onClose={handleClose} />;
}

/**
 * The explainer's actual UI: Bloom's adaptive `Dialog` — a bottom sheet on narrow
 * viewports, a centered card on desktop — stepping through the three cards.
 * Mounted ONLY once a request exists, so `useTranslation` here is always safe.
 *
 * It owns its own `control` and OPENS ITSELF on mount: the Dialog's imperative
 * handle binds `control` during the commit's layout phase, before this passive
 * mount effect runs, so `control.open()` always reaches a bound handle — no
 * `setTimeout` and no dependency on how the request was triggered.
 */
function ChannelInfoDialogContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const control = useDialogControl();
  const [step, setStep] = useState<ExplainerStep>(0);

  useEffect(() => {
    control.open();
  }, [control]);

  const isFirstStep = step === 0;
  const isLastStep = step === 2;

  const onPrimary = useCallback(() => {
    if (isLastStep) {
      control.close();
      return;
    }
    setStep((current) => (current + 1) as ExplainerStep);
  }, [control, isLastStep]);

  const onSecondary = useCallback(() => {
    if (isFirstStep) {
      control.close();
      return;
    }
    setStep((current) => (current - 1) as ExplainerStep);
  }, [control, isFirstStep]);

  const dots = useMemo(
    () =>
      STEP_KEYS.map((keys, index) => (
        <View
          key={keys.title}
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
      label={t('channels.explainer.title')}
    >
      <View className="items-center gap-4 py-4">
        <View className="w-20 h-20 rounded-full bg-primary/10 items-center justify-center">
          <ChannelIcon size={40} className="text-primary" />
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
          {isLastStep ? t('channels.explainer.done') : t('channels.explainer.next')}
        </Button>
        <Button variant="ghost" size="large" onPress={onSecondary}>
          {isFirstStep ? t('channels.explainer.cancel') : t('channels.explainer.back')}
        </Button>
      </View>
    </Dialog>
  );
}
