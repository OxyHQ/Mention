import { useCallback, useEffect, useRef, useState } from 'react';

import { MAX_VIDEO_SECONDS } from './constants';

/**
 * What the recorder is doing. `arming` is not a formality — see below.
 */
export type RecorderPhase = 'idle' | 'arming' | 'recording';

/** The subset of `CameraView` this hook drives. Narrowed so a test can supply it. */
export interface RecorderCamera {
  recordAsync: (options?: { maxDuration?: number }) => Promise<{ uri: string } | undefined>;
  stopRecording: () => void;
}

interface UseVideoRecorderOptions {
  camera: () => RecorderCamera | null;
  /**
   * Ask for the microphone. Returning `false` cancels the recording before the
   * camera is touched — a video with no sound is worse than one not taken, and
   * the reader has just said no.
   */
  requestMicrophone: () => Promise<boolean>;
  /** Fires once, with whatever was recorded. */
  onRecorded: (uri: string) => void;
  maxSeconds?: number;
}

/**
 * The recording half of the capture surface, as a state machine.
 *
 * IT OWNS `mode`, AND THAT IS THE WHOLE REASON IT EXISTS. `CameraView` captures
 * stills in `picture` mode and video in `video` mode, and the prop only takes
 * effect once React has COMMITTED it — so a press cannot set the mode and call
 * `recordAsync` on the next line. The press ARMS a recording; an effect starts
 * it once the mode has actually landed; a press that ends before then disarms
 * it, which is what keeps a fast tap a photo. Spread across a component that is
 * also doing gestures, layout and permissions, that dance is where the bugs go,
 * so it lives here on its own and is tested on its own.
 *
 * The microphone is asked for while ARMING rather than on mount: a reader who
 * only ever takes photos is never asked, and a refusal cancels the video and
 * leaves photos working.
 */
export function useVideoRecorder({
  camera,
  requestMicrophone,
  onRecorded,
  maxSeconds = MAX_VIDEO_SECONDS,
}: UseVideoRecorderOptions) {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [startedAt, setStartedAt] = useState<number | null>(null);

  /**
   * The synchronous half of `phase`.
   *
   * State lands on the next render and a finger arrives before that, so a second
   * press would otherwise arm a second recording over the first.
   */
  const busy = useRef(false);

  /**
   * Which press the machine is currently working for.
   *
   * `phase` CANNOT ANSWER THAT, and this is the reason: `arm()` has to await the
   * microphone before it can set any state at all, and a finger can lift inside
   * that await — at which point `phase` is still `idle` and `stop()` would see
   * nothing to cancel, while the resolved permission goes on to start a
   * recording nobody is holding. So a press bumps this on the way in, `stop()`
   * bumps it on the way out, and every step that resumes after an await checks
   * that the token it started with is still the current one.
   */
  const pressToken = useRef(0);

  /** Recording resolves long after a page blur can unmount this. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const arm = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const token = ++pressToken.current;

    let granted = false;
    try {
      granted = await requestMicrophone();
    } catch {
      granted = false;
    }

    // The press ended inside the await, or a later one took over. `stop()` has
    // already released `busy`, so this path must not touch it.
    if (pressToken.current !== token || !mounted.current) return;
    if (!granted) {
      busy.current = false;
      return;
    }
    setPhase('arming');
    setMode('video');
  }, [requestMicrophone]);

  useEffect(() => {
    if (phase !== 'arming' || mode !== 'video') return;
    const device = camera();
    if (!device) {
      // The preview went away between arming and committing — a page blur, most
      // likely. Reset rather than wait for a camera that is not there.
      busy.current = false;
      setPhase('idle');
      setMode('picture');
      return;
    }

    // NO CLEANUP HERE, deliberately. Setting `phase` below re-runs this effect,
    // and a cleanup that abandoned the in-flight recording would abandon the one
    // it had just started — the clip would be recorded and then dropped. The
    // re-run returns at the guard above instead, and what survives an unmount is
    // `mounted` rather than a closure over one particular run.
    const token = pressToken.current;
    setPhase('recording');
    setStartedAt(Date.now());

    void (async () => {
      try {
        // Resolves when `stopRecording` is called or `maxDuration` is reached,
        // which is why the capture is reported from here and not from the press.
        const video = await device.recordAsync({ maxDuration: maxSeconds });
        if (video?.uri && mounted.current) onRecorded(video.uri);
      } finally {
        // A newer press owns the machine if the token moved; leave its state be.
        if (pressToken.current === token) {
          busy.current = false;
          if (mounted.current) {
            setPhase('idle');
            setMode('picture');
            setStartedAt(null);
          }
        }
      }
    })();
  }, [phase, mode, camera, maxSeconds, onRecorded]);

  /**
   * End the press.
   *
   * Recording → ask the camera to stop, and the effect above reports the result.
   * The token is deliberately NOT bumped on that path: stopping is how a
   * recording is meant to end, and invalidating it here would throw away the
   * clip the reader just took.
   *
   * Anything else → the press ended before the recording began, either inside
   * the permission await or in the gap before `video` mode landed. Both undo to
   * the same place, and the token is what makes the first one stick.
   */
  const stop = useCallback(() => {
    if (phase === 'recording') {
      camera()?.stopRecording();
      return;
    }
    pressToken.current += 1;
    busy.current = false;
    if (phase === 'arming') {
      setPhase('idle');
      setMode('picture');
    }
  }, [phase, camera]);

  return { phase, mode, startedAt, arm, stop, isRecording: phase === 'recording' };
}
