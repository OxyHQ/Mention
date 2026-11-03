import { useCallback, useEffect, useRef } from 'react';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { checkoutFeedbackSounds } from '@peable.to/sdk/checkout/ui';
import {
  createCheckoutFeedback,
  type CheckoutFeedbackResult,
  type FeedbackPlayer,
} from '@/lib/payments/checkoutFeedback';

/** Local checkout feedback respects the device silent switch and the preview mute control. */
export function useCheckoutFeedback(enabled: boolean) {
  const controller = useRef<ReturnType<typeof createCheckoutFeedback> | null>(null);
  if (!controller.current)
    controller.current = createCheckoutFeedback({
      configure: () =>
        setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' }),
      create: (result) =>
        createAudioPlayer(checkoutFeedbackSounds[result]) as unknown as FeedbackPlayer,
    });
  useEffect(() => {
    if (!enabled) controller.current?.stop();
    return () => controller.current?.stop();
  }, [enabled]);
  const play = useCallback(
    (result: CheckoutFeedbackResult, attempt: number) => {
      void controller.current?.play(result, attempt, enabled);
    },
    [enabled],
  );
  const stop = useCallback(() => controller.current?.stop(), []);
  return { play, stop };
}
