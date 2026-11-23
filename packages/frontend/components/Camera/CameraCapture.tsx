import { toast } from '@oxy.so/bloom/toast';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
} from 'expo-camera';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { useTranslation } from 'react-i18next';

import type { BloomIconComponent } from '@oxy.so/bloom';
import { RiCameraSwitchLine } from '@oxy.so/bloom/icons/RiCameraSwitchLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { RiTimerLine } from '@oxy.so/bloom/icons/RiTimerLine';
import { Text, fontFamilyStyle } from '@oxy.so/bloom/typography';
import {
  FLASH_CHOICES,
  HOLD_TO_RECORD_MS,
  MAX_VIDEO_SECONDS,
  TIMER_CHOICES,
  ZOOM_DRAG_DISTANCE_PX,
  ZOOM_STOPS,
  formatMultiplier,
  multiplierToZoom,
  nextChoice,
  shutterAction,
  stopForZoom,
  zoomToMultiplier,
  type CaptureMode,
  type FlashChoice,
  type TimerChoice,
} from './constants';
import { useVideoRecorder } from './useVideoRecorder';
import type { LocalCapture } from './useCaptureUpload';
import {
  Button as LButton,
  Embed,
  HStack,
  Text as LText,
  VStack,
  defineTokens,
  toElement,
  Embed as LEmbed,
  VStack as LVStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

/**
 * The camera's own colours: the selected zoom stop (`text-yellow-400`, as NativeWind
 * drew it), the selected stop's darker disc, the recording red and a control's
 * badge.
 */
const cameraColors = defineTokens({
  color: {
    active: '#fcc800',
    zoomSelected: 'rgba(0,0,0,0.55)',
    recording: '#ef4444',
    badge: '#facc15',
  },
});
/**
 * Where the camera's chrome sits over the frame: the control column's top, the
 * shutter row's distance from the bottom, a zoom stop's narrowest width and the
 * zoom row's distance from the bottom.
 */
const cameraSpace = defineTokens({
  space: { controlTop: 52, controlsBottom: 74, zoomStop: 34, zoomRowBottom: 148 },
});

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

/** The carousel's order, left to right. Photo first: it is what a camera opens on. */
const CAPTURE_MODES: readonly CaptureMode[] = ['photo', 'video'];

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
 * surface where hesitation is the cost. Close top-left; flash and self-timer in
 * a column top-right; the zoom stops in a row just above the shutter; the
 * shutter centred at the bottom with flip beside it; and under it the MODE
 * CAROUSEL — Photo or Video — which is the one control that says what the big
 * button is for.
 *
 * Every one of those sits on a translucent disc rather than bare on the frame.
 * Chrome over a live preview has to stay legible against whatever the lens
 * happens to be pointing at, and white-on-white is the failure mode.
 *
 * The gestures are the familiar ones too: TAP is the mode's action, HOLD always
 * records, PINCH zooms anywhere on the preview, and DRAGGING UP from the shutter
 * zooms without a second finger. That last one is the signature — it is why the
 * zoom is not a slider, and why the drag distance is fixed to a thumb's reach
 * rather than to the screen's height.
 *
 * WHAT IS DELIBERATELY NOT HERE. Instagram's camera also carries layouts,
 * boomerang, green screen, a teleprompter, touch-up and filters. Each of those
 * is a product decision and every one needs a filter or segment pipeline this
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
 * IT IS NEVER IN A WEB BUNDLE. Its only importer is `CameraPage.tsx`, which is
 * module-forked: Metro resolves `CameraPage` to `CameraPage.web.tsx` on web, so
 * nothing on that side names this file or `expo-camera`. The `expo-camera`
 * import must stay here, below that fork, and never move up into the route
 * file — expo-router bundles every route file on every platform.
 * `components/Camera/__tests__/cameraWebBoundary.test.ts` keeps it true.
 *
 * THE PREVIEW IS ONLY MOUNTED WHILE THE PAGE IS FOCUSED, and its owner enforces
 * that by not rendering this component otherwise (`CameraPage.tsx`). A
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
  /**
   * PHOTO or VIDEO, chosen on the carousel under the shutter.
   *
   * It replaced a "hands free" toggle in the control column, and the swap is
   * worth a line: the toggle described a MECHANISM (does the button need
   * holding) where a reader is choosing an OUTCOME (am I taking a photo or a
   * video). Naming the outcome also puts the answer where the eye already is —
   * under the shutter, which is where every phone camera puts it.
   */
  const [captureMode, setCaptureMode] = useState<CaptureMode>('photo');
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
  const recordingFailed = useCallback(() => {
    toast.error(t('camera.recordingFailed'));
  }, [t]);
  // Destructured so the callbacks below depend on the pieces they use rather
  // than on a hook result that is a new object every render.
  const {
    arm,
    stop,
    isRecording,
    phase,
    mode,
    startedAt,
    cameraReady,
    cameraError,
    recordingProgress,
    generation,
  } = useVideoRecorder({
    camera: getCamera,
    requestMicrophone,
    onRecorded,
    onError: recordingFailed,
  });

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
   * The shutter's TAP. What it does is {@link shutterAction}'s decision.
   */
  const onShutterPress = useCallback(() => {
    const action = shutterAction(captureMode, isRecording);
    if (action === 'stop') {
      stop();
      return;
    }
    afterTimer(action === 'record' ? () => void arm() : () => void takePhoto());
  }, [captureMode, isRecording, stop, afterTimer, arm, takePhoto]);

  /** A hold owns one recording; a video tap toggles independently of touch lifetime. */
  const heldRecording = useRef(false);
  const onShutterLongPress = useCallback(() => {
    if (isRecording || countdown !== null) return;
    heldRecording.current = true;
    void arm();
  }, [isRecording, countdown, arm]);

  const finishShutterGesture = useCallback(() => {
    if (!heldRecording.current) return;
    heldRecording.current = false;
    stop();
  }, [stop]);

  // The ring fills over the whole allowance, so its angle IS the time left; the
  // seconds beside it are the same fact for a reader who needs the number.
  useEffect(() => {
    if (!isRecording || startedAt === null) {
      ringProgress.value = 0;
      setRemaining(MAX_VIDEO_SECONDS);
      return;
    }
    ringProgress.value = withTiming(1, { duration: MAX_VIDEO_SECONDS * 1000 });
    const began = startedAt;
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
        .withTestId('camera-shutter-drag')
        .runOnJS(true)
        .onUpdate((event) => {
          // UP is negative, and only up counts: dragging down from the shutter
          // is how a thumb leaves the control, not a request to zoom out past 0.
          setZoom(clampZoom(Math.max(0, -event.translationY) / ZOOM_DRAG_DISTANCE_PX));
        })
        // The pan owns the touch until it ends, fails without movement, or is
        // cancelled. Pressable.onPressOut also fires when this pan takes over;
        // treating that responder handoff as finger-up truncates the recording.
        .onFinalize(() => {
          finishShutterGesture();
          // The zoom belongs to the take, not to the camera: releasing returns to
          // 1x so the next capture starts where the reader expects.
          setZoom(0);
        }),
    [finishShutterGesture],
  );

  // The arc IS the time left: `strokeDashoffset` walks the circumference as the
  // recording runs, so the ring empties exactly when the allowance does. An
  // opacity fade would have looked like a ring while measuring nothing.
  const ringAnimatedProps = useAnimatedProps(() => ({
    strokeDashoffset: RING_CIRCUMFERENCE * (1 - ringProgress.value),
  }));

  /**
   * What the pill row shows.
   *
   * `selectedStop` is null when the zoom sits BETWEEN two stops — the case the
   * row renders differently rather than rounds away. Exactly one pill is still
   * highlighted (the nearest), and it borrows its label from the live figure so
   * a pinch has somewhere to be read.
   */
  const multiplier = zoomToMultiplier(zoom);
  const selectedStop = stopForZoom(zoom);
  const activeStop =
    selectedStop ??
    ZOOM_STOPS.reduce((closest, stop) =>
      Math.abs(stop - multiplier) < Math.abs(closest - multiplier) ? stop : closest,
    );

  // `permission` is null only while the module is still answering. Deciding
  // "denied" then would show the explanation to someone who has not been asked.
  if (!permission) return toElement(VStack().grow().background('black'));

  if (!permission.granted) {
    return toElement(
      VStack(
        LText(t('camera.permissionTitle', { defaultValue: 'Let Mention use the camera' }))
          .foreground('white')
          .font('18')
          .leading('28px')
          .textAlign('center')
          .margin('bottom', 'sm'),
        LText(
          t('camera.permissionBody', {
            defaultValue: 'Photos and videos you take here are only posted when you choose to.',
          }),
        )
          .foreground('white/70')
          .font('16')
          .leading('24px')
          .textAlign('center')
          .margin('bottom', '2xl'),
        /* `canAskAgain` is false once the reader has refused twice on iOS; the
           prompt would never appear, so the honest button is the one that goes
           back rather than one that silently does nothing. */
        permission.canAskAgain
          ? LButton(LText(t('camera.permissionAllow', { defaultValue: 'Allow camera' })))
              .onPress(requestPermission)
              .size('lg')
          : LButton(LText(t('common.close', { defaultValue: 'Close' })))
              .onPress(onClose)
              .size('lg'),
      )
        .padding('horizontal', '3xl')
        .background('black')
        .align('center')
        .justify('center')
        .grow(),
    );
  }

  const recording = isRecording;

  return toElement(
    VStack(
      Embed(
        <GestureDetector gesture={pinch}>
          {LtoElement(
            LVStack(
              /* Preserve the native owner across mode changes: Expo CameraX disposal
                          unbinds the process-wide provider and can tear down a replacement
                          camera that React mounted before the old view's cleanup. */ LEmbed(
                <CameraView
                  onCameraReady={() => cameraReady(mode, generation)}
                  onMountError={(event) => cameraError(event, generation)}
                  onRecordingProgress={(event) => recordingProgress(event, generation)}
                  ref={cameraRef}
                  style={StyleSheet.absoluteFill}
                  facing={facing}
                  mode={mode}
                  flash={flash}
                  // The torch is the flash's meaning DURING a recording: a still's
                  // flash fires once and would light nothing for a video.
                  enableTorch={recording && flash === 'on'}
                  zoom={zoom}
                />,
              ),
            ).position({ top: 'none', right: 'none', bottom: 'none', left: 'none' }),
          )}
        </GestureDetector>,
      ),
      /* Every control sits on its own translucent disc rather than bare on the
         frame. A camera's chrome has to stay legible over whatever the lens
         happens to be pointing at, and white-on-white is the failure mode. */
      Embed(
        <RoundButton
          style={styles.close}
          onPress={onClose}
          icon={RiCloseLine}
          label={t('common.close', { defaultValue: 'Close' })}
        />,
      ),
      /* The modal controls, in a column where the thumb is not covering the
         frame. Each is a cycle rather than a menu: one target, one tap. */
      VStack(
        Embed(
          <RoundButton
            onPress={() => setFlash(nextChoice(FLASH_CHOICES, flash))}
            // One bolt for every setting: the colour says off or on, and the "A" is
            // how every camera distinguishes automatic from on.
            icon={RiFlashlightLine}
            badge={flash === 'auto' ? 'A' : undefined}
            active={flash !== 'off'}
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
          />,
        ),
        Embed(
          <RoundButton
            onPress={() => setTimer(nextChoice(TIMER_CHOICES, timer))}
            icon={RiTimerLine}
            badge={timer === 0 ? undefined : String(timer)}
            active={timer !== 0}
            label={t('camera.timer', { defaultValue: 'Timer' })}
            value={timer === 0 ? t('camera.timerOff', { defaultValue: 'Off' }) : `${timer}s`}
          />,
        ),
      )
        .spacing('10')
        .position({ top: cameraSpace.space.controlTop, right: 'lg' }),
      countdown !== null
        ? VStack(Embed(<Text style={styles.countdownText}>{countdown}</Text>))
            .align('center')
            .justify('center')
            .position({ top: 'none', left: 'none', right: 'none', bottom: 'none' })
            .allowsHitTesting(false)
        : null,
      recording
        ? HStack(
            VStack()
              .frame({ width: 'sm', height: 'sm' })
              .background(cameraColors.color.recording)
              .corner('xs'),
            LText(phase === 'starting' ? t('camera.preparing') : formatRemaining(remaining))
              .foreground('white')
              .font('14')
              .leading('20px'),
          )
            .align('center')
            .spacing('6')
            .padding('horizontal', '10')
            .padding('vertical', 'xs')
            .background('black/45')
            .corner('full')
            .position({ top: '5xl' })
            .alignSelf('center')
            .allowsHitTesting(false)
        : null,
      /* ZOOM STOPS, the row a phone camera puts just above its shutter. The
         pinch and the drag move the same value, so the selected pill follows
         them; between two stops the selected one shows the live multiplier
         instead of its own label, which is the only way the row can stay
         honest about a zoom it did not choose. */
      HStack(
        Embed(
          ZOOM_STOPS.map((stop) => {
            const selected = stop === activeStop;
            // Its own label when the zoom is ON the stop, the live figure when it
            // is merely nearest to it.
            const text =
              selected && selectedStop === null ? formatMultiplier(multiplier) : `${stop}×`;
            return toElement(
              VStack(
                LText(text)
                  .font('xs')
                  .leading('16px')
                  .foreground(selected ? cameraColors.color.active : 'white'),
              )
                .padding('horizontal', 'sm')
                .frame({ minWidth: cameraSpace.space.zoomStop, height: '28' })
                .when(selected, (v) => v.background(cameraColors.color.zoomSelected))
                .corner('14')
                .align('center')
                .justify('center')
                .onPress(() => setZoom(multiplierToZoom(stop)))
                .role('button')
                .label(
                  t('camera.zoomTo', {
                    defaultValue: 'Zoom to {{amount}}',
                    amount: `${stop}×`,
                  }),
                ),
              stop,
            );
          }),
        ),
      )
        .align('center')
        .spacing('xs')
        .padding('xs')
        .background('black/40')
        .corner('full')
        .position({ bottom: cameraSpace.space.zoomRowBottom })
        .alignSelf('center'),
      HStack(
        /* Keeps the shutter centred where the thumb expects it. Instagram's
           gallery shortcut would live here; `CameraCapture`'s header says why
           this app's does not. */
        VStack().frame({ width: '48', height: '48' }).corner('2xl'),
        Embed(
          <GestureDetector gesture={shutterDrag}>
            <Animated.View>
              <Pressable
                onPress={onShutterPress}
                onLongPress={onShutterLongPress}
                delayLongPress={HOLD_TO_RECORD_MS}
                accessibilityRole="button"
                // The control does more than one thing and a reader who cannot see
                // it has no other way to learn the rest.
                accessibilityLabel={
                  recording
                    ? t('camera.stop', { defaultValue: 'Stop recording' })
                    : captureMode === 'video'
                      ? t('camera.record', { defaultValue: 'Start recording' })
                      : t('camera.shutter', { defaultValue: 'Take a photo' })
                }
                accessibilityHint={
                  captureMode === 'video'
                    ? t('camera.shutterHintVideo', { defaultValue: 'Tap again to stop' })
                    : t('camera.shutterHint', {
                        defaultValue: 'Hold to record a video, and drag up to zoom',
                      })
                }
                style={styles.shutterHitArea}
              >
                {/* A RING plus a separate core, not one filled circle: the core is
                    what changes between the three states, and animating a border
                    colour would have moved the ring with it. */}
                <View style={styles.shutterRing}>
                  <View
                    style={[
                      styles.shutterCore,
                      captureMode === 'video' && styles.shutterCoreVideo,
                      recording && styles.shutterCoreRecording,
                    ]}
                  />
                </View>
              </Pressable>
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
          </GestureDetector>,
        ),
        Embed(
          <RoundButton
            style={[styles.sideSlot, recording && styles.slotHidden]}
            onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
            disabled={recording}
            icon={RiCameraSwitchLine}
            label={t('camera.flip', { defaultValue: 'Switch camera' })}
          />,
        ),
      )
        .padding('horizontal', '4xl')
        .align('center')
        .justify('between')
        .position({ left: 'none', right: 'none', bottom: cameraSpace.space.controlsBottom }),
      /* THE MODE CAROUSEL, the row of names under the shutter that every phone
         camera has and that says what the button is for. It is hidden while
         recording: changing mode mid-take is not a thing it can honour, and a
         control that is present but inert is worse than one that stepped
         aside. */
      recording
        ? null
        : HStack(
            Embed(
              CAPTURE_MODES.map((option) =>
                LtoElement(
                  LVStack(
                    LEmbed(
                      toElement(
                        LText(
                          option === 'video'
                            ? t('camera.modeVideo', { defaultValue: 'Video' })
                            : t('camera.modePhoto', { defaultValue: 'Photo' }),
                        )
                          .font('xs')
                          .leading('16px')
                          .when(option === captureMode, (v) => v.foreground('white').weight('bold'))
                          .when(!(option === captureMode), (v) => v.foreground('white/half')),
                      ),
                    ),
                  )
                    .padding('horizontal', '14')
                    .padding('vertical', '6')
                    .onPress(() => setCaptureMode(option))
                    .role('button')
                    .accessibilityState({ selected: option === captureMode })
                    .label(
                      option === 'video'
                        ? t('camera.modeVideo', { defaultValue: 'Video' })
                        : t('camera.modePhoto', { defaultValue: 'Photo' }),
                    ),
                  option,
                ),
              ),
            ),
          )
            .align('center')
            .justify('center')
            .spacing('xs')
            .position({ left: 'none', right: 'none', bottom: '30' }),
    )
      .grow()
      .background('black'),
  );
}

/**
 * One control on a translucent disc: an icon, optionally a small corner badge
 * carrying the value the icon alone cannot say.
 */
function RoundButton({
  icon: Icon,
  label,
  value,
  badge,
  active,
  disabled,
  style,
  onPress,
}: {
  icon: BloomIconComponent;
  label: string;
  /** The setting's current value, for the announced name. Omit for a plain action. */
  value?: string;
  badge?: string;
  active?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.roundButton, style]}
      accessibilityRole="button"
      // The label alone would announce "Flash" whatever it is set to, which is
      // the one thing a reader who cannot see the icon needs to know.
      accessibilityLabel={value ? `${label}: ${value}` : label}
    >
      <Icon width={20} height={20} fill={active ? '#facc15' : '#fff'} />
      {badge
        ? toElement(
            VStack(LText(badge).font('9').weight('bold').foreground('black'))
              .align('center')
              .justify('center')
              .padding('horizontal', '3')
              .frame({ minWidth: '14', height: '14' })
              .background(cameraColors.color.badge)
              .corner('7')
              .position({ top: '1', right: '1' }),
          )
        : null}
    </Pressable>
  );
}

/** `m:ss` left, which is what a reader checks mid-take. */
function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  // Off Bloom's type scale (`text-8xl font-bold`) in the display face, as Bloom's Text
  // drew it from a size of `text-3xl` up: the language's Text has the size ('96') and
  // the line ('96px') but draws the display face only for a ramp step, never at a
  // numeric size, so the countdown stays a view.
  countdownText: {
    ...fontFamilyStyle('display'),
    color: '#fff',
    fontSize: 96,
    lineHeight: 96,
    fontWeight: '700',
  },
  close: { position: 'absolute', top: 56, left: 20 },
  roundButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    // Dark enough to carry a white icon over a bright frame, light enough that
    // the preview still reads through it.
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sideSlot: { width: 48, height: 48, borderRadius: 24 },
  slotHidden: { opacity: 0 },
  // The hit area is the RING's box, so the drag-to-zoom gesture and the press
  // start from the same place a thumb aims at.
  shutterHitArea: { alignItems: 'center', justifyContent: 'center' },
  shutterRing: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // White and nearly filling the ring in photo mode — the still-camera shutter
  // everyone recognises.
  shutterCore: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  shutterCoreVideo: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#ef4444' },
  // The rounded SQUARE is the universal "stop", and shrinking it inside the
  // untouched ring is what makes the progress arc read as progress.
  shutterCoreRecording: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#ef4444' },
  ring: { position: 'absolute', top: -8, left: -8 },
  modeItem: { paddingHorizontal: 14, paddingVertical: 6 },
});
