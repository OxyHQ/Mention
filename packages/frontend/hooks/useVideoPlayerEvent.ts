import { useEffect, useRef } from 'react';
import type { VideoPlayer, VideoPlayerEvents } from 'expo-video';

/**
 * `useEventListener` from `expo` for a player that may not be attached yet.
 *
 * A feed row draws its poster and controls before the shared pool gives it a
 * player and keeps drawing them after the player is given back, so the
 * component that listens is mounted while `player` is `null`. Expo's hook
 * subscribes unconditionally; this one subscribes while there is a player and
 * moves with it when it changes. The latest `listener` is always the one called.
 */
export function useVideoPlayerEvent<TEvent extends keyof VideoPlayerEvents>(
  player: VideoPlayer | null,
  event: TEvent,
  listener: VideoPlayerEvents[TEvent],
): void {
  const listenerRef = useRef(listener);
  useEffect(() => {
    listenerRef.current = listener;
  });
  useEffect(() => {
    if (!player) return;
    const forward = ((...args: Parameters<VideoPlayerEvents[TEvent]>) =>
      (listenerRef.current as (...a: typeof args) => void)(...args)) as VideoPlayerEvents[TEvent];
    const subscription = player.addListener(event, forward);
    return () => subscription.remove();
  }, [player, event]);
}
