import { useEffect } from 'react';
import { createScopedLogger } from '@/lib/logger';

/**
 * Binds the OS transport controls to whatever the reel is playing, through the
 * Media Session API.
 *
 * This is what puts **next / previous** inside Chromium's Picture-in-Picture
 * window — the one place a browser lets an app add buttons to that window — and
 * it is the same registration that drives media keys, the lock screen, and the
 * OS media notification, so it is deliberately NOT gated on PiP support.
 *
 * Everything here is feature-detected twice over, because the API is partially
 * implemented almost everywhere: `mediaSession` may be missing entirely (React
 * Native, older browsers), and `setActionHandler` THROWS `NotSupportedError` for
 * an action name the browser does not know — so each action is registered on its
 * own and a failure only costs that one button. Safari, which honours none of
 * these actions in its PiP window, must come out of this with no buttons rather
 * than an exception.
 */

const logger = createScopedLogger('MediaSessionTransport');

/**
 * How far a relative seek moves when the OS asks for one without naming an
 * offset — the ±10s every video player uses, and what Chromium labels its own
 * seek buttons with.
 */
const DEFAULT_SEEK_OFFSET_SECONDS = 10;

export interface MediaSessionTrack {
  title: string;
  artist: string;
  /** Absolute URL of the poster frame. */
  artwork?: string;
}

export interface MediaSessionTransportOptions {
  /** What is playing right now; `null` tears the session's metadata down. */
  track: MediaSessionTrack | null;
  onNext: () => void;
  onPrevious: () => void;
  /** Relative seek, in seconds; negative seeks backwards. */
  onSeek: (seconds: number) => void;
}

/** The live `MediaSession`, or `null` wherever the API does not exist. */
function getMediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
  return navigator.mediaSession;
}

/**
 * Register (or clear) ONE action. Guarded individually: an unknown action name
 * throws, and one unsupported button must never take the rest of the transport
 * — or the screen — down with it.
 */
function setActionHandler(
  session: MediaSession,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch (error) {
    logger.debug('Media session action unsupported', { action, error });
  }
}

export function useMediaSessionTransport({
  track,
  onNext,
  onPrevious,
  onSeek,
}: MediaSessionTransportOptions): void {
  // The metadata is a DOM singleton the browser reads to label its own UI —
  // synchronising it with what is playing, and clearing it on the way out, is
  // the textbook external-system effect.
  useEffect(() => {
    const session = getMediaSession();
    if (session === null || track === null) return;
    try {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        artwork: track.artwork ? [{ src: track.artwork }] : [],
      });
    } catch (error) {
      // A browser with `mediaSession` but no `MediaMetadata`, or artwork it
      // refuses: the transport still works, it just goes unlabelled.
      logger.debug('Media session metadata rejected', { error });
    }
    return () => {
      session.metadata = null;
    };
  }, [track]);

  useEffect(() => {
    const session = getMediaSession();
    if (session === null) return;
    const handlers: ReadonlyArray<readonly [MediaSessionAction, MediaSessionActionHandler]> = [
      ['nexttrack', onNext],
      ['previoustrack', onPrevious],
      ['seekforward', ({ seekOffset }) => onSeek(seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS)],
      ['seekbackward', ({ seekOffset }) => onSeek(-(seekOffset ?? DEFAULT_SEEK_OFFSET_SECONDS))],
    ];
    for (const [action, handler] of handlers) {
      setActionHandler(session, action, handler);
    }
    return () => {
      for (const [action] of handlers) {
        setActionHandler(session, action, null);
      }
    };
  }, [onNext, onPrevious, onSeek]);
}
