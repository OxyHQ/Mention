<<<<<<< HEAD
import { useEffect } from 'react';
import { createLogger } from '@oxyhq/core/logger';
import { useRefSync } from '@/hooks/useRefSync';
=======
import { useEffect, useRef } from 'react';
import { createScopedLogger } from '@/lib/logger';
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
import {
  addPipActionListener,
  clearPipActions,
  getMaxPipActions,
  isPipTransportAvailable,
  setPipActions,
  type PipTransportAction,
  type PipTransportActionId,
} from '@/modules/pip-transport';

/**
 * Next / previous inside the **Android** OS Picture-in-Picture window — the
 * native counterpart of {@link useMediaSessionTransport}, wired into the same
 * session so a press swaps the source on the player the OS is showing rather
 * than moving a pager nobody can see.
 *
 * Android caps how many actions a PiP window shows, and the cap is a runtime
 * query on the device rather than a constant, so the list is built against
 * whatever `getMaxNumPictureInPictureActions()` answers and degrades by dropping
 * the least useful button first.
 *
 * Where the native module is absent — iOS, web, or any build made before it
 * landed, since `android/` is CNG-generated and this ships only at the next
 * prebuild — every call below is a no-op and nothing throws.
 */

<<<<<<< HEAD
const logger = createLogger('PipTransportActions');
=======
const logger = createScopedLogger('PipTransportActions');
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

/**
 * Which button survives the clamp, most valuable first. A reel is watched
 * forwards: with room for only one control, "next" is the one worth having.
 */
const ACTION_PRIORITY: readonly PipTransportActionId[] = ['next', 'previous'];

/** Where the survivors sit in the window, left to right — transport order. */
const ACTION_DISPLAY_ORDER: readonly PipTransportActionId[] = ['previous', 'next'];

export interface PipTransportLabels {
  next: string;
  previous: string;
}

/**
 * The action list for a device that will show at most `maxActions` of them.
 *
 * Two orders, deliberately: the clamp drops from the END of
 * {@link ACTION_PRIORITY}, and whatever is left is laid out in
 * {@link ACTION_DISPLAY_ORDER}. Collapsing them into one list would either put
 * "next" on the left of "previous" or throw away the wrong button.
 */
export function buildPipTransportActions(
  labels: PipTransportLabels,
  maxActions: number,
): PipTransportAction[] {
  const kept = new Set(ACTION_PRIORITY.slice(0, Math.max(0, maxActions)));
  return ACTION_DISPLAY_ORDER
    .filter((id) => kept.has(id))
    .map((id) => ({ id, title: labels[id] }));
}

export interface UsePipTransportActionsOptions {
  /** Whether a PiP session is open — the actions exist for exactly that long. */
  active: boolean;
  /** Localized labels, passed apart so a re-render cannot re-issue the list. */
  nextLabel: string;
  previousLabel: string;
  onNext: () => void;
  onPrevious: () => void;
}

export function usePipTransportActions({
  active,
  nextLabel,
  previousLabel,
  onNext,
  onPrevious,
}: UsePipTransportActionsOptions): void {
  // The handlers change on every pager move, and re-subscribing on each one
  // would tear the native BroadcastReceiver down and back up (it lives exactly
  // as long as a JS listener does) several times a scroll. Read them at press
  // time instead, so the subscription only ever tracks the session.
<<<<<<< HEAD
  //
  // Synced through `useRefSync` — an Effect — rather than written in the render
  // body: a render-phase ref write is illegal input for the React Compiler, and
  // it refuses this whole hook over it (measured: removing the write is the only
  // thing between here and a compiled hook). The commit-time write also answers
  // the right question, since a press can only land on a committed tree. What a
  // stale pair would cost: `onNext` is rebuilt whenever the session opens, and
  // the open version routes the press to the PiP cursor while the closed one
  // pages the reel — so a stale handler would scroll a pager nobody can see and
  // leave the OS window on the same video, which is the exact failure this hook
  // exists to prevent.
  const nextRef = useRefSync(onNext);
  const previousRef = useRefSync(onPrevious);
=======
  const handlersRef = useRef({ onNext, onPrevious });
  handlersRef.current = { onNext, onPrevious };
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)

  // Publishing to (and withdrawing from) the OS window is external-system
  // synchronization with a real teardown — the effect case this is for. Keyed on
  // the session and the labels alone: a rejected call costs the buttons, never
  // the screen, exactly as an unsupported media-session action does on web.
  useEffect(() => {
    if (!isPipTransportAvailable || !active) return;
    const actions = buildPipTransportActions(
      { next: nextLabel, previous: previousLabel },
      getMaxPipActions(),
    );
    // No room for a single button (no PiP on this device, or a cap of zero):
    // nothing was published, so there is nothing to withdraw either.
    if (actions.length === 0) return;

    setPipActions(actions).catch((error: unknown) => {
      logger.debug('Could not publish Picture-in-Picture actions', { error });
    });
    return () => {
      clearPipActions().catch((error: unknown) => {
        logger.debug('Could not clear Picture-in-Picture actions', { error });
      });
    };
  }, [active, nextLabel, previousLabel]);

  useEffect(() => {
    if (!active) return;
    const subscription = addPipActionListener((event) => {
      switch (event.id) {
        case 'next':
<<<<<<< HEAD
          nextRef.current();
          break;
        case 'previous':
          previousRef.current();
=======
          handlersRef.current.onNext();
          break;
        case 'previous':
          handlersRef.current.onPrevious();
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
          break;
      }
    });
    return () => subscription?.remove();
  }, [active]);
}
