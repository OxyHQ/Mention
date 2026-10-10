/** @jest-environment jsdom */
/**
 * HLS on web: which sources go to hls.js, and what an element plays when its
 * stream fails.
 *
 * Oxy's own ladder (`?variant=hls_master`) is an H.264 transcode every browser
 * decodes, where the uploaded original may be VP9 — which an iPhone cannot
 * decode at all. So web plays the ladder, through hls.js where the browser
 * decodes H.264 through Media Source Extensions (`ManagedMediaSource` on recent
 * iOS), natively where it does not (older Safari).
 *
 * The hook's attach path loads hls.js through `import()`, which Jest cannot
 * execute; the browser gate covers it. What is pure is pinned here.
 */

import { URL as NodeURL } from 'node:url';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoViewHandle } from '@oxy.so/bloom/video-view';
import { needsJsHlsDecoder, playProgressiveInstead, useHlsPlayback } from '../hlsPlayback.web';

const LADDER = 'https://cloud.oxy.so/m1?variant=hls_master';
const ORIGINAL = 'https://cloud.oxy.so/m1';

// This jsdom build ships no usable `URL` constructor, which `isHlsSource` parses with.
beforeAll(() => {
  Object.defineProperty(globalThis, 'URL', { configurable: true, writable: true, value: NodeURL });
});

function withMediaSource(supported: boolean) {
  Object.defineProperty(window, 'ManagedMediaSource', {
    configurable: true,
    value: { isTypeSupported: () => supported },
  });
}

afterEach(() => {
  delete (window as { ManagedMediaSource?: unknown }).ManagedMediaSource;
});

describe('needsJsHlsDecoder', () => {
  it("sends Oxy's ladder to hls.js where the browser decodes H.264 through MSE", () => {
    withMediaSource(true);
    expect(needsJsHlsDecoder(LADDER)).toBe(true);
  });

  it('never sends a progressive file there', () => {
    withMediaSource(true);
    expect(needsJsHlsDecoder(ORIGINAL)).toBe(false);
  });

  it('leaves the ladder to the element where MSE cannot decode it (Safari plays HLS natively)', () => {
    expect(needsJsHlsDecoder(LADDER)).toBe(false);
    withMediaSource(false);
    expect(needsJsHlsDecoder(LADDER)).toBe(false);
  });
});

describe('playProgressiveInstead', () => {
  function video(): HTMLVideoElement & { play: jest.Mock } {
    const element = document.createElement('video') as HTMLVideoElement & { play: jest.Mock };
    element.play = jest.fn(() => Promise.resolve());
    return element;
  }

  it('gives the element the original and keeps playing a video that was playing', () => {
    const element = video();
    playProgressiveInstead(element, ORIGINAL, true);
    expect(element.src).toBe(ORIGINAL);
    expect(element.play).toHaveBeenCalledTimes(1);
  });

  it('does not start a video that was paused', () => {
    const element = video();
    playProgressiveInstead(element, ORIGINAL, false);
    expect(element.src).toBe(ORIGINAL);
    expect(element.play).not.toHaveBeenCalled();
  });

  it('swallows an autoplay refusal; the viewer can still tap play', async () => {
    const element = video();
    element.play.mockReturnValueOnce(Promise.reject(new DOMException('denied', 'NotAllowedError')));
    expect(() => playProgressiveInstead(element, ORIGINAL, true)).not.toThrow();
    await Promise.resolve();
  });
});

/**
 * The hook attaches through the view's `ref`, not an effect: a flight host
 * mounts its video after the owner's effects run, and an effect that read the
 * ref once found nothing and never asked again. These pin the ref's contract;
 * the hls.js attach itself sits behind an `import()` Jest cannot execute.
 */
describe('useHlsPlayback ref', () => {
  function hookFor(src: string) {
    const viewRef: { current: VideoViewHandle | null } = { current: null };
    let playback: ReturnType<typeof useHlsPlayback> | undefined;
    function Probe() {
      playback = useHlsPlayback(src, viewRef);
      return null;
    }
    act(() => {
      TestRenderer.create(createElement(Probe));
    });
    if (!playback) throw new Error('hook did not render');
    return { playback, viewRef };
  }

  const handleFor = (element: unknown) =>
    ({ nativeRef: { current: element } }) as unknown as VideoViewHandle;

  type RefCallback = (handle: VideoViewHandle | null) => (() => void) | undefined;

  it("fills the caller's ref for a progressive source, and attaches nothing", () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(ORIGINAL);
    const handle = handleFor(document.createElement('video'));

    expect(playback.active).toBe(false);
    expect((playback.ref as RefCallback)(handle)).toBeUndefined();
    expect(viewRef.current).toBe(handle);
    (playback.ref as RefCallback)(null);
    expect(viewRef.current).toBeNull();
  });

  it('attaches to the element when the view mounts it, and releases it on cleanup', () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(LADDER);
    const handle = handleFor(document.createElement('video'));

    expect(playback.active).toBe(true);
    const cleanup = (playback.ref as RefCallback)(handle);
    expect(viewRef.current).toBe(handle);
    expect(typeof cleanup).toBe('function');

    act(() => cleanup?.());
    expect(viewRef.current).toBeNull();
  });

  it('leaves the ref to a newer view when an older one is cleaned up', () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(LADDER);
    const older = handleFor(document.createElement('video'));
    const newer = handleFor(document.createElement('video'));

    const cleanupOlder = (playback.ref as RefCallback)(older);
    (playback.ref as RefCallback)(newer);
    act(() => cleanupOlder?.());

    expect(viewRef.current).toBe(newer);
  });

  it('attaches nothing to a view whose element is not a <video>', () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(LADDER);
    const handle = handleFor(null);

    expect((playback.ref as RefCallback)(handle)).toBeUndefined();
    expect(viewRef.current).toBe(handle);
  });
});
