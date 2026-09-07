import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType } from 'expo-camera';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { Button } from '@/components/ui/Button';
import {
  FLASH_CHOICES,
  HOLD_TO_RECORD_MS,
  MAX_VIDEO_SECONDS,
  TIMER_CHOICES,
  ZOOM_DRAG_DISTANCE_PX,
  nextChoice,
  type FlashChoice,
  type TimerChoice,
} from './constants';
import { useVideoRecorder } from './useVideoRecorder';
import type { LocalCapture } from './useCaptureUpload';

/** The arc drawn around the shutter while recording. */
const RING_SIZE = 92;
const RING_RADIUS = 42;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Built at module scope, as reanimated requires: a component created during
 * render is a new type every time, so the tree remounts and the animation
 * restarts on each frame it was meant to drive.
 */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * `CameraView.zoom` is 0–1, and out of range is not an error it reports — it is
 * a preview that stops responding. Both zoom gestures clamp through here.
 */
function clampZoom(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface CameraCaptureProps {
  /** Fires with whatever the reader just captured. */
  onCaptured: (capture: LocalCapture) => void;
  /** Leave the camera — the X, and the hardware back. */
  onClose: () => void;
}

/**
 * The live camera.
 *
 * LAID OUT LIKE THE ONE EVERY READER ALREADY KNOWS, because a camera is a
 * surface where hesitation is the cost: close top-left, the modal controls in a
 * column top-right, and the shutter centred at the bottom with flip beside it.
 * The gestures
 * are the same ones too — TAP takes a photo, HOLD records, and DRAGGING UP from
 * the shutter while holding zooms. That last one is the signature: it is why the
 * zoom is not a slider, and why the drag distance is fixed to a thumb's reach
 * rather than to the screen's height.
 *
 * WHAT IS DELIBERATELY NOT HERE. Instagram's camera also carries a mode
 * carousel, layouts, boomerang, green screen, a teleprompter and touch-up. Each
 * of those is a product decision and most need a filter or segment pipeline this
 * app does not have; adding a control that does nothing would be worse than the
 * absence.
 *
 * The library shortcut is out for a different reason, and it is worth stating so
 * nobody adds it carelessly. The app's picker returns files ALREADY UPLOADED to
 * Oxy, while `pendingShareMedia` — the buffer that carries media to the composer
 * — is keyed by a real content type. Reusing the picker means either inventing a
 * MIME to satisfy that field or widening a hook the composer shares. Neither is
 * a shortcut worth taking for a second way to reach a picker the composer
 * already offers one tap later.
 *
 * THE RECORDING STATE MACHINE IS `useVideoRecorder`, not this file, and the
 * reason is in that hook: `CameraView`'s `mode` prop only takes effect once
 * React commits it, so recording has to be armed and then started, and that
 * dance does not belong in a component already handling gestures and layout.
 *
 * IT IS ALSO THE WEB BUNDLE'S BOUNDARY, and that is why the `expo-camera` import
 * is HERE rather than in the route file. Expo-router puts every route file in
 * the graph — a `.web.tsx` route sibling does not keep its native twin out, and
 * `dist/` was shipping a 31KB `camera` chunk carrying `expo-camera`'s web build
 * to a platform that never renders it. A module fork does keep it out: Metro
 * resolves `./CameraCapture` to `CameraCapture.web.tsx` on web, so nothing on
 * that side ever names the package. Same mechanism as
 * `components/navigation/TabsPager.web.tsx` and `react-native-pager-view`, and
 * `components/Camera/__tests__/cameraWebBoundary.test.ts` is what keeps it true.
 *
 * THE PREVIEW IS ONLY MOUNTED WHILE THE PAGE IS FOCUSED, and its owner enforces
 * that by not rendering this component otherwise (`(tabs)/camera.tsx`). A
 * `CameraView` left mounted holds the sensor: the OS indicator stays lit, the
 * battery drains, and on Android a second surface cannot open one. That is also
 * why the page declares `preload: false` — a camera mounted merely for being
 * Home's neighbour would do all of that behind the feed.
 */
export function CameraCapture({ onCaptured, onClose }: CameraCaptureProps) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashChoice>('off');
  const [timer, setTimer] = useState<TimerChoice>(0);
  const [handsFree, setHandsFree] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(MAX_VIDEO_SECONDS);

  const cameraRef = useRef<CameraView>(null);
  const takingPhoto = useRef(false);

  /**
   * Zoom lives in REACT STATE, not on the UI thread, and that is forced rather
   * than chosen: `CameraView.zoom` is a plain prop, so the value has to reach a
   * render whatever the gesture writes it to. Keeping a shared value beside it
   * would be a second source of truth that buys no frames.
   */
  const [zoom, setZoom] = useState(0);

  /** The ring around the shutter. Animated, so this one IS a shared value. */
  const ringProgress = useSharedValue(0);

  const getCamera = useCallback(() => cameraRef.current, []);

  /**
   * The microphone is a SECOND runtime permission and the camera grant does not
   * carry it; `app.config.js` only declares the native one and its usage string.
   * `canAskAgain` false means the prompt would never appear, so there is nothing
   * to await — refuse quietly and leave photos working.
   */
  const requestMicrophone = useCallback(async () => {
    if (micPermission?.granted) return true;
    if (!micPermission?.canAskAgain) return false;
    const granted = await requestMicPermission();
    return Boolean(granted?.granted);
  }, [micPermission, requestMicPermission]);

  const onRecorded = useCallback(
    (uri: string) => onCaptured({ uri, kind: 'video', mimeType: 'video/mp4' }),
    [onCaptured],
  );
  // Destructured so the callbacks below depend on the pieces they use rather
  // than on a hook result that is a new object every render.
  const {
    arm,
    stop,
    isRecording,
    phase,
    mode,
    startedAt,
  } = useVideoRecorder({ camera: getCamera, requestMicrophone, onRecorded });

  const takePhoto = useCallback(async () => {
    if (takingPhoto.current || phase !== 'idle') return;
    takingPhoto.current = true;
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) onCaptured({ uri: photo.uri, kind: 'image', mimeType: 'image/jpeg' });
    } finally {
      takingPhoto.current = false;
    }
  }, [onCaptured, phase]);

  /**
   * The self-timer, as a plain countdown that ends in the action it was started
   * for. Cancelled by unmounting — leaving the page mid-countdown must not fire
   * a capture into a camera that is gone.
   */
  const cancelCountdown = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelCountdown.current?.(), []);

  /**
   * Run `action` now, or after the self-timer.
   *
   * A press DURING a countdown cancels it, which is what every camera does and
   * the only honest alternative to a shutter that has gone dead for ten seconds.
   */
  const afterTimer = useCallback(
    (action: () => void) => {
      if (countdown !== null) {
        cancelCountdown.current?.();
        cancelCountdown.current = null;
        setCountdown(null);
        return;
      }
      if (timer === 0) {
        action();
        return;
      }
      setCountdown(timer);
      let left: number = timer;
      const id = setInterval(() => {
        left -= 1;
        if (left > 0) {
          setCountdown(left);
          return;
        }
        clearInterval(id);
        setCountdown(null);
        action();
      }, 1000);
      cancelCountdown.current = () => clearInterval(id);
    },
    [countdown, timer],
  );

  /**
   * The shutter's TAP.
   *
   * Hands-free turns the same tap into start-and-stop for video, which is the
   * whole point of the mode: a recording you do not have to hold. Off, a tap is
   * a photo and video is the HOLD below.
   */
  const onShutterPress = useCallback(() => {
    if (isRecording) {
      stop();
      return;
    }
    afterTimer(handsFree ? () => void arm() : () => void takePhoto());
  }, [isRecording, stop, afterTimer, handsFree, arm, takePhoto]);

  /**
   * The shutter's HOLD, which is video.
   *
   * NO SELF-TIMER ON THIS PATH, deliberately: a held recording already has a
   * finger on the button, so counting down first would mean holding through the
   * countdown for nothing. The timer belongs to the tap.
   */
  const onShutterLongPress = useCallback(() => {
    if (handsFree || countdown !== null) return;
    void arm();
  }, [handsFree, countdown, arm]);

  /**
   * The shutter's RELEASE.
   *
   * ON THE PRESSABLE RATHER THAN THE PAN GESTURE, and that is the difference
   * between a working shutter and one that records for three minutes: a hold
   * with no movement never ACTIVATES a pan, so its `onEnd` never runs. React
   * Native's own responder fires `onPressOut` on release AND on termination —
   * including the termination the pan causes when a drag does take over — so it
   * is the one signal present on every path.
   */
  const onShutterRelease = useCallback(() => {
    // In hands-free the press that started the recording also ends here, and
    // must not stop it — that is what the tap above is for.
    if (handsFree) return;
    stop();
  }, [handsFree, stop]);

  // The ring fills over the whole allowance, so its angle IS the time left; the
  // seconds beside it are the same fact for a reader who needs the number.
  useEffect(() => {
    if (!isRecording) {
      ringProgress.value = 0;
      setRemaining(MAX_VIDEO_SECONDS);
      return;
    }
    ringProgress.value = withTiming(1, { duration: MAX_VIDEO_SECONDS * 1000 });
    const began = startedAt ?? Date.now();
    const id = setInterval(() => {
      const elapsed = Math.floor((Date.now() - began) / 1000);
      setRemaining(Math.max(0, MAX_VIDEO_SECONDS - elapsed));
    }, 250);
    return () => clearInterval(id);
  }, [isRecording, startedAt, ringProgress]);

  /**
   * ZOOM, by the two gestures a camera is expected to have: a pinch anywhere on
   * the preview, and a drag up from the shutter.
   *
   * A pinch, applied as a per-frame DELTA.
   *
   * `onChange` rather than `onUpdate`, for `scaleChange`: the change since the
   * previous frame, where `onUpdate`'s `scale` is measured from where the
   * gesture began — and the difference matters here. Against `scale` this would
   * have to remember the zoom at the pinch's start, which means a ref holding a
   * copy of state plus an effect keeping the two in step; a delta folds into the
   * setter it already has and needs neither.
   *
   * A quarter of the range per doubling reads about right against the system
   * camera.
   *
   * ON THE JS THREAD ON PURPOSE: `CameraView.zoom` is a plain prop, so every
   * update has to reach a React render whatever thread computed it. A worklet
   * would hop to the UI thread and straight back for nothing.
   */
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .runOnJS(true)
        .onChange((event) => {
          setZoom((current) => clampZoom(current + (event.scaleChange - 1) * 0.25));
        }),
    [],
  );

  const shutterDrag = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onUpdate((event) => {
          // UP is negative, and only up counts: dragging down from the shutter
          // is how a thumb leaves the control, not a request to zoom out past 0.
          setZoom(clampZoom(Math.max(0, -event.translationY) / ZOOM_DRAG_DISTANCE_PX));
        })
        // `onFinalize`, not `onEnd`: a hold that never moved does not ACTIVATE a
        // pan, and only this one runs on every touch that began. The release
        // itself is the Pressable's — see `onShutterRelease`.
        .onFinalize(() => {
          // The zoom belongs to the take, not to the camera: releasing returns to
          // 1x so the next capture starts where the reader expects.
          setZoom(0);
        }),
    [],
  );

  // The arc IS the time left: `strokeDashoffset` walks the circumference as the
  // recording runs, so the ring empties exactly when the allowance does. An
  // opacity fade would have looked like a ring while measuring nothing.
  const ringAnimatedProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_CIRCUMFERENCE * (1 - ringProgress.value),
  }));

  // `permission` is null only while the module is still answering. Deciding
  // "denied" then would show the explanation to someone who has not been asked.
  if (!permission) return <View style={styles.root} />;

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.explain]}>
        <ThemedText className="text-white text-lg text-center mb-2">
          {t('camera.permissionTitle', { defaultValue: 'Let Mention use the camera' })}
        </ThemedText>
        <ThemedText className="text-white/70 text-center mb-6">
          {t('camera.permissionBody', {
            defaultValue: 'Photos and videos you take here are only posted when you choose to.',
          })}
        </ThemedText>
        {/* `canAskAgain` is false once the reader has refused twice on iOS; the
            prompt would never appear, so the honest button is the one that goes
            back rather than one that silently does nothing. */}
        {permission.canAskAgain ? (
          <Button onPress={requestPermission}>
            {t('camera.permissionAllow', { defaultValue: 'Allow camera' })}
          </Button>
        ) : (
          <Button onPress={onClose}>{t('common.close', { defaultValue: 'Close' })}</Button>
        )}
      </View>
    );
  }

  const recording = isRecording;

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinch}>
        <View style={StyleSheet.absoluteFill}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode={mode}
            flash={flash}
            // The torch is the flash's meaning DURING a recording: a still's
            // flash fires once and would light nothing for a video.
            enableTorch={recording && flash === 'on'}
            zoom={zoom}
          />
        </View>
      </GestureDetector>

      <Pressable
        onPress={onClose}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
      >
        <ThemedText className="text-white text-2xl">×</ThemedText>
      </Pressable>

      {/* The modal controls, in a column where the thumb is not covering the
          frame. Each is a cycle rather than a menu: one target, one tap. */}
      <View style={styles.controlColumn}>
        <ControlButton
          label={t('camera.flash', { defaultValue: 'Flash' })}
          // FLAT keys, not `camera.flash.<value>`: `camera.flash` is itself a
          // string here, and i18next cannot have a key be both a leaf and a
          // parent — the nested lookups would silently fall back to English.
          value={
            flash === 'off'
              ? t('camera.flashOff', { defaultValue: 'Off' })
              : flash === 'auto'
                ? t('camera.flashAuto', { defaultValue: 'Auto' })
                : t('camera.flashOn', { defaultValue: 'On' })
          }
          glyph={flash === 'off' ? '⚡︎' : flash === 'auto' ? 'A⚡' : '⚡'}
          dimmed={flash === 'off'}
          onPress={() => setFlash(nextChoice(FLASH_CHOICES, flash))}
        />
        <ControlButton
          label={t('camera.timer', { defaultValue: 'Timer' })}
          value={timer === 0 ? t('camera.timerOff', { defaultValue: 'Off' }) : `${timer}s`}
          glyph={timer === 0 ? '⏱' : `${timer}`}
          dimmed={timer === 0}
          onPress={() => setTimer(nextChoice(TIMER_CHOICES, timer))}
        />
        <ControlButton
          label={t('camera.handsFree', { defaultValue: 'Hands free' })}
          value={
            handsFree
              ? t('camera.handsFreeOn', { defaultValue: 'On' })
              : t('camera.handsFreeOff', { defaultValue: 'Off' })
          }
          glyph="◉"
          dimmed={!handsFree}
          onPress={() => setHandsFree((current) => !current)}
        />
      </View>

      {countdown !== null ? (
        <View style={styles.countdown} pointerEvents="none">
          <ThemedText className="text-white text-8xl font-bold">{countdown}</ThemedText>
        </View>
      ) : null}

      {recording ? (
        <View style={styles.recordingBadge} pointerEvents="none">
          <View style={styles.recordingDot} />
          <ThemedText className="text-white text-sm">{formatRemaining(remaining)}</ThemedText>
        </View>
      ) : null}

      {zoom > 0.01 ? (
        <View style={styles.zoomBadge} pointerEvents="none">
          <ThemedText className="text-white text-sm">{formatZoom(zoom)}</ThemedText>
        </View>
      ) : null}

      <View style={styles.controls}>
        {/* Keeps the shutter centred where the thumb expects it. */}
        <View style={styles.sideSlot} />

        <GestureDetector gesture={shutterDrag}>
          <Animated.View>
            <Pressable
              onPress={onShutterPress}
              onLongPress={onShutterLongPress}
              onPressOut={onShutterRelease}
              delayLongPress={HOLD_TO_RECORD_MS}
              accessibilityRole="button"
              // The control does more than one thing and a reader who cannot see
              // it has no other way to learn the rest.
              accessibilityLabel={
                recording
                  ? t('camera.stop', { defaultValue: 'Stop recording' })
                  : handsFree
                    ? t('camera.record', { defaultValue: 'Start recording' })
                    : t('camera.shutter', { defaultValue: 'Take a photo' })
              }
              accessibilityHint={
                handsFree
                  ? t('camera.shutterHintHandsFree', {
                      defaultValue: 'Tap again to stop',
                    })
                  : t('camera.shutterHint', {
                      defaultValue: 'Hold to record a video, and drag up to zoom',
                    })
              }
              style={[styles.shutter, recording && styles.shutterRecording]}
            />
            {recording ? (
              <Svg width={RING_SIZE} height={RING_SIZE} style={styles.ring} pointerEvents="none">
                <AnimatedCircle
                  cx={RING_SIZE / 2}
                  cy={RING_SIZE / 2}
                  r={RING_RADIUS}
                  stroke="#ef4444"
                  strokeWidth={4}
                  strokeLinecap="round"
                  fill="none"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  animatedProps={ringAnimatedProps}
                  // Start the arc at the top, where a clock does.
                  transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                />
              </Svg>
            ) : null}
          </Animated.View>
        </GestureDetector>

        <Pressable
          onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
          disabled={recording}
          style={[styles.sideSlot, recording && styles.slotHidden]}
          accessibilityRole="button"
          accessibilityLabel={t('camera.flip', { defaultValue: 'Switch camera' })}
        >
          <ThemedText className="text-white text-xl">⟲</ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

/** One modal control: a glyph, and the value it is currently on. */
function ControlButton({
  label,
  value,
  glyph,
  dimmed,
  onPress,
}: {
  label: string;
  value: string;
  glyph: string;
  dimmed: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.controlButton}
      accessibilityRole="button"
      // The label alone would announce "Flash" whatever it is set to, which is
      // the one thing a reader who cannot see the glyph needs to know.
      accessibilityLabel={`${label}: ${value}`}
    >
      <ThemedText className={dimmed ? 'text-white/50 text-lg' : 'text-white text-lg'}>
        {glyph}
      </ThemedText>
    </Pressable>
  );
}

/** `m:ss` left, which is what a reader checks mid-take. */
function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The zoom as a multiplier, the way every camera app labels it. */
function formatZoom(value: number): string {
  return `${(1 + value * 4).toFixed(1)}×`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  explain: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  close: { position: 'absolute', top: 56, left: 20, padding: 12 },
  controlColumn: { position: 'absolute', top: 52, right: 16, gap: 4 },
  controlButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  countdown: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingBadge: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  zoomBadge: {
    position: 'absolute',
    bottom: 150,
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 40,
  },
  sideSlot: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  slotHidden: { opacity: 0 },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 5,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterRecording: { backgroundColor: '#ef4444', borderColor: '#ef4444' },
  ring: { position: 'absolute', top: -8, left: -8 },
});
