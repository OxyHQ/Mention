import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useVideoRecorder, type RecorderCamera } from '../useVideoRecorder';
import {
  FLASH_CHOICES,
  MAX_ZOOM_MULTIPLIER,
  TIMER_CHOICES,
  ZOOM_STOPS,
  formatMultiplier,
  multiplierToZoom,
  nextChoice,
  shutterAction,
  stopForZoom,
  zoomToMultiplier,
} from '../constants';

/**
 * The recording state machine, which is the part of the camera that a device
 * would otherwise be the only witness to.
 *
 * THE ARMING STEP IS THE WHOLE POINT. `CameraView` captures stills in `picture`
 * mode and video in `video` mode, and the prop only takes effect once React has
 * COMMITTED it — so a press cannot set the mode and call `recordAsync` on the
 * next line. Every case below is about that gap: what happens in it, and what
 * happens when the press ends inside it.
 *
 * A wrong answer here does not throw. It records when the reader meant to take a
 * photo, or takes a photo when they meant to record — which is why this is
 * pinned rather than left to a manual pass on a phone.
 */

function fakeCamera() {
  let resolveRecording: ((value: { uri: string } | undefined) => void) | undefined;
  const camera: RecorderCamera = {
    recordAsync: jest.fn(
      () =>
        new Promise<{ uri: string } | undefined>((resolve) => {
          resolveRecording = resolve;
        }),
    ),
    stopRecording: jest.fn(() => resolveRecording?.({ uri: 'file:///clip.mp4' })),
  };
  return camera;
}

function mountRecorder(options: {
  camera: RecorderCamera | null;
  microphone?: () => Promise<boolean>;
  onRecorded?: (uri: string) => void;
}) {
  const seen: { current: ReturnType<typeof useVideoRecorder> | null } = { current: null };
  const Probe = () => {
    seen.current = useVideoRecorder({
      camera: () => options.camera,
      requestMicrophone: options.microphone ?? (() => Promise.resolve(true)),
      onRecorded: options.onRecorded ?? jest.fn(),
    });
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  return {
    get value() {
      if (!seen.current) throw new Error('the recorder never rendered');
      return seen.current;
    },
    unmount: () => act(() => renderer?.unmount()),
  };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('arming a recording', () => {
  it('starts in picture mode, so a tap is a photo', () => {
    const recorder = mountRecorder({ camera: fakeCamera() });

    expect(recorder.value.mode).toBe('picture');
    expect(recorder.value.phase).toBe('idle');
  });

  it('asks for video mode BEFORE recording, and records once it lands', async () => {
    const camera = fakeCamera();
    const recorder = mountRecorder({ camera });

    await act(async () => {
      await recorder.value.arm();
    });

    expect(recorder.value.mode).toBe('video');
    await flush();
    expect(camera.recordAsync).toHaveBeenCalledTimes(1);
    expect(recorder.value.isRecording).toBe(true);
  });

  it('reports the clip and returns to picture mode when it stops', async () => {
    const camera = fakeCamera();
    const onRecorded = jest.fn();
    const recorder = mountRecorder({ camera, onRecorded });

    await act(async () => {
      await recorder.value.arm();
    });
    await flush();
    act(() => {
      recorder.value.stop();
    });
    await flush();

    expect(onRecorded).toHaveBeenCalledWith('file:///clip.mp4');
    expect(recorder.value.phase).toBe('idle');
    // Back to `picture`, or the next tap would record instead of taking a photo.
    expect(recorder.value.mode).toBe('picture');
  });

  it('DISARMS when the press ends before video mode lands — a fast tap', async () => {
    // The case the arming step exists for: releasing during the gap must leave
    // no recording behind, or a tap meant as a photo becomes a video.
    const camera = fakeCamera();
    const recorder = mountRecorder({ camera });

    const arming = recorder.value.arm();
    act(() => {
      recorder.value.stop();
    });
    await act(async () => {
      await arming;
    });
    await flush();

    expect(camera.recordAsync).not.toHaveBeenCalled();
    expect(recorder.value.mode).toBe('picture');
    expect(recorder.value.phase).toBe('idle');
  });

  it('never arms twice, however fast the second press is', async () => {
    // State lands on the next render and a finger arrives before that, so the
    // guard has to be synchronous.
    const camera = fakeCamera();
    const recorder = mountRecorder({ camera });

    await act(async () => {
      await Promise.all([recorder.value.arm(), recorder.value.arm()]);
    });
    await flush();

    expect(camera.recordAsync).toHaveBeenCalledTimes(1);
  });
});

describe('the microphone', () => {
  it('is asked for before the camera is touched', async () => {
    const camera = fakeCamera();
    const microphone = jest.fn(() => Promise.resolve(true));
    const recorder = mountRecorder({ camera, microphone });

    await act(async () => {
      await recorder.value.arm();
    });

    expect(microphone).toHaveBeenCalled();
  });

  it('cancels the recording when it is refused, leaving photos working', async () => {
    // A silent video is worse than one not taken, and the reader has just said
    // no — so this is a cancel, not an error, and the mode never leaves picture.
    const camera = fakeCamera();
    const recorder = mountRecorder({ camera, microphone: () => Promise.resolve(false) });

    await act(async () => {
      await recorder.value.arm();
    });
    await flush();

    expect(camera.recordAsync).not.toHaveBeenCalled();
    expect(recorder.value.mode).toBe('picture');
  });

  it('can be tried again after a refusal', async () => {
    // The guard must release on the refusal path, or the shutter would be dead
    // for the rest of the session.
    const camera = fakeCamera();
    const microphone = jest
      .fn<Promise<boolean>, []>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const recorder = mountRecorder({ camera, microphone });

    await act(async () => {
      await recorder.value.arm();
    });
    await act(async () => {
      await recorder.value.arm();
    });
    await flush();

    expect(camera.recordAsync).toHaveBeenCalledTimes(1);
  });
});

describe('a preview that went away', () => {
  it('resets instead of waiting for a camera that is not there', async () => {
    // The page blurred between arming and committing. `(tabs)/camera.tsx`
    // unmounts the preview on blur precisely so the sensor is released.
    const recorder = mountRecorder({ camera: null });

    await act(async () => {
      await recorder.value.arm();
    });
    await flush();

    expect(recorder.value.phase).toBe('idle');
    expect(recorder.value.mode).toBe('picture');
  });
});

describe('the control cycles', () => {
  it('walk their choices and wrap', () => {
    expect(nextChoice(FLASH_CHOICES, 'off')).toBe('auto');
    expect(nextChoice(FLASH_CHOICES, 'auto')).toBe('on');
    expect(nextChoice(FLASH_CHOICES, 'on')).toBe('off');
    expect(nextChoice(TIMER_CHOICES, 0)).toBe(3);
    expect(nextChoice(TIMER_CHOICES, 10)).toBe(0);
  });

  it('restart rather than stall on a value they do not know', () => {
    // A control that stops responding is worse than one that resets, and this is
    // reachable through a persisted preference from an older build.
    expect(nextChoice(FLASH_CHOICES, 'screen' as never)).toBe('off');
  });

  it('start where a camera should: no flash, no timer', () => {
    expect(FLASH_CHOICES[0]).toBe('off');
    expect(TIMER_CHOICES[0]).toBe(0);
  });
});

describe('what a tap on the shutter does', () => {
  it('takes a photo in photo mode and records in video mode', () => {
    expect(shutterAction('photo', false)).toBe('photo');
    expect(shutterAction('video', false)).toBe('record');
  });

  it('STOPS whatever the mode says, once something is recording', () => {
    // The order matters and is easy to invert: a hold in photo mode leaves a
    // recording running, and the next tap has to end it rather than fire the
    // shutter into a camera that is mid-take.
    expect(shutterAction('photo', true)).toBe('stop');
    expect(shutterAction('video', true)).toBe('stop');
  });
});

describe('the zoom pills', () => {
  it('read a zoom as the multiplier they are labelled with', () => {
    expect(zoomToMultiplier(0)).toBe(1);
    expect(zoomToMultiplier(1)).toBe(MAX_ZOOM_MULTIPLIER);
    expect(zoomToMultiplier(multiplierToZoom(2))).toBeCloseTo(2);
    expect(zoomToMultiplier(multiplierToZoom(3))).toBeCloseTo(3);
  });

  it('clamp a multiplier the lens cannot reach instead of driving zoom out of range', () => {
    // An out-of-range `zoom` is not an error `CameraView` reports; it is a
    // preview that stops responding.
    expect(multiplierToZoom(0.5)).toBe(0);
    expect(multiplierToZoom(50)).toBe(1);
  });

  it('offer only stops the range actually covers', () => {
    for (const stop of ZOOM_STOPS) {
      expect(stop).toBeGreaterThanOrEqual(1);
      expect(stop).toBeLessThanOrEqual(MAX_ZOOM_MULTIPLIER);
    }
  });

  it('report NO stop between two of them, so the row can show the live figure', () => {
    expect(stopForZoom(0)).toBe(1);
    expect(stopForZoom(multiplierToZoom(2))).toBe(2);
    expect(stopForZoom(multiplierToZoom(2.4))).toBeNull();
  });

  it('write a whole multiplier whole', () => {
    // A pill sitting on its own stop should read like the label it is; "2.0×"
    // makes the row look like it is measuring something it is not.
    expect(formatMultiplier(2)).toBe('2×');
    expect(formatMultiplier(1.75)).toBe('1.8×');
  });
});
