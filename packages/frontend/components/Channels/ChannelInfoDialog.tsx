import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiMegaphoneLine } from '@oxy.so/bloom/icons/RiMegaphoneLine';
import {
  Button as LButton,
  Embed,
  HStack,
  Icon,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Dialog as LDialog } from '@oxy.so/bloom-language/overlays';

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
 * It is presented from its first render (its binding starts true), so it opens
 * however the request was triggered; closing flips the binding, and once the
 * dialog has finished leaving, `onDismissed` tells the host to unmount it.
 */
function ChannelInfoDialogContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [isPresented, setPresented] = useState(true);
  const [step, setStep] = useState<ExplainerStep>(0);

  const isFirstStep = step === 0;
  const isLastStep = step === 2;

  const onPrimary = useCallback(() => {
    if (isLastStep) {
      setPresented(false);
      return;
    }
    setStep((current) => (current + 1) as ExplainerStep);
  }, [isLastStep]);

  const onSecondary = useCallback(() => {
    if (isFirstStep) {
      setPresented(false);
      return;
    }
    setStep((current) => (current - 1) as ExplainerStep);
  }, [isFirstStep]);

  const dots = useMemo(
    () =>
      STEP_KEYS.map((keys, index) =>
        toElement(
          VStack()
            .frame({ width: 'sm', height: 'sm' })
            .corner('infinite')
            .when(index === step, (v) => v.background('primary'))
            .when(!(index === step), (v) => v.background('border')),
          keys.title,
        ),
      ),
    [step],
  );

  return toElement(
    LDialog(
      VStack(
        VStack(Icon(RiMegaphoneLine).size('40').foreground('primary'))
          .frame({ width: '80', height: '80' })
          .background('primary/10')
          .corner('infinite')
          .align('center')
          .justify('center'),
        RawText(t(STEP_KEYS[step].title))
          .foreground('foreground')
          .font('xl')
          .leading('28px')
          .weight('bold')
          .textAlign('center'),
        RawText(t(STEP_KEYS[step].body))
          .foreground('muted')
          .font('16')
          .leading('24px')
          .textAlign('center'),
      )
        .padding('vertical', 'lg')
        .align('center')
        .spacing('lg'),
      HStack(Embed(dots)).padding('vertical', 'lg').align('center').justify('center').spacing('sm'),
      /*
       * ONE ROW, and each button takes an equal half of it.
       *
       * Reading order is what puts the secondary first: left to right the pair
       * says "leave" then "continue", and the primary keeps the end of the line
       * a thumb reaches for. `flex-1` on both rather than letting each size to
       * its own label, because the split must not move as the labels do, and
       * they change on every card (Cancel to Back, Next to Got it) and in every
       * language. Halves also mean the longest label anywhere is measured
       * against a fixed box: the widest pairs are Spanish "Cancelar / Siguiente"
       * and Italian "Indietro / Ho capito", both well past any English one, so
       * English is the wrong string to eyeball this with.
       */
      HStack(
        LButton(LText(isFirstStep ? t('channels.explainer.cancel') : t('channels.explainer.back')))
          .style('plain')
          .tint('neutral')
          .size('lg')
          .onPress(onSecondary)
          .flex('1'),
        LButton(LText(isLastStep ? t('channels.explainer.done') : t('channels.explainer.next')))
          .style('solid')
          .tint('accent')
          .size('lg')
          .onPress(onPrimary)
          .flex('1'),
      )
        .align('center')
        .spacing('md'),
    )
      .presentAt('bottom', { md: 'center' })
      .label(t('channels.explainer.title'))
      .onDismissed(onClose)
      .presented([isPresented, setPresented]),
  );
}
