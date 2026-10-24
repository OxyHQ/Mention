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
 * The decoder is mocked at the hls.js boundary; the real hook and playback
 * controller execute, including demand changes and teardown. Browser tests
 * separately assert actual decoded frames and MediaSource continuity.
 */

import { URL as NodeURL } from 'node:url';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { VideoViewHandle } from '@oxy.so/bloom/video-view';
import type { VideoPlayer } from 'expo-video';
import { useVideoPlaybackControl } from '@oxy.so/bloom/video-playback';
import { needsJsHlsDecoder, playProgressiveInstead, useHlsPlayback } from '../hlsPlayback.web';

interface MockDecoder {
  url?: string;
  attachMedia: jest.Mock;
  loadSource: jest.Mock;
  startLoad: jest.Mock;
  stopLoad: jest.Mock;
  destroy: jest.Mock;
  emitError: (fatal: boolean) => void;
}
const mockHlsInstances: MockDecoder[] = [];
jest.mock('hls.js', () => ({
  __esModule: true,
  default: class MockHls implements MockDecoder {
    static Events: { ERROR: string } = { ERROR: 'error' };
    url?: string;
    private onError?: (event: string, data: { fatal: boolean }) => void;
    attachMedia = jest.fn();
    loadSource = jest.fn((source: string) => {
      this.url = source;
    });
    startLoad = jest.fn();
    stopLoad = jest.fn();
    destroy = jest.fn();
    constructor() {
      mockHlsInstances.push(this);
    }
    on(_event: string, callback: (event: string, data: { fatal: boolean }) => void) {
      this.onError = callback;
    }
    emitError(fatal: boolean) {
      this.onError?.('error', { fatal });
    }
  },
}));
const mounted: TestRenderer.ReactTestRenderer[] = [];
const fakePlayer = () =>
  ({
    play: jest.fn(),
    pause: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  }) as unknown as VideoPlayer;

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

afterEach(async () => {
  await act(async () => {
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  mockHlsInstances.length = 0;
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
 * The view ref publishes the actual element to the decoder effect. A flight
 * host may mount it after the presenter's effects have run; transient imperative
 * handle replacement must not be mistaken for element removal. These pin the
 * ref contract; the decoder lifecycle is exercised separately below.
 */
describe('useHlsPlayback ref', () => {
  function hookFor(src: string) {
    const viewRef: { current: VideoViewHandle | null } = { current: null };
    let playback: ReturnType<typeof useHlsPlayback> | undefined;
    const player = fakePlayer();
    function Probe() {
      playback = useHlsPlayback(src, viewRef, player);
      return null;
    }
    act(() => {
      mounted.push(TestRenderer.create(createElement(Probe)));
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
    act(() => {
      expect((playback.ref as RefCallback)(handle)).toBeUndefined();
    });
    expect(viewRef.current).toBe(handle);
    (playback.ref as RefCallback)(null);
    expect(viewRef.current).toBeNull();
  });

  it('updates the view handle without treating its transient ref cleanup as decoder teardown', () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(LADDER);
    const element = document.createElement('video');
    const older = handleFor(element);
    const newer = handleFor(element);
    act(() => {
      playback.ref(older);
    });
    expect(viewRef.current).toBe(older);
    act(() => {
      playback.ref(null);
      playback.ref(newer);
    });
    expect(viewRef.current).toBe(newer);
  });

  it('attaches nothing to a view whose element is not a <video>', () => {
    withMediaSource(true);
    const { playback, viewRef } = hookFor(LADDER);
    const handle = handleFor(null);

    act(() => {
      expect((playback.ref as RefCallback)(handle)).toBeUndefined();
    });
    expect(viewRef.current).toBe(handle);
  });
});

describe('HLS decoder lifetime and demand', () => {
  async function mountDecoder(source = LADDER, loading = false, fallback?: string) {
    withMediaSource(true);
    const element = document.createElement('video');
    element.play = jest.fn(() => Promise.resolve());
    const viewRef: { current: VideoViewHandle | null } = { current: null };
    const player = fakePlayer();
    let playback: ReturnType<typeof useHlsPlayback> | undefined;
    function Probe(props: {
      source: string;
      loading: boolean;
      fallback?: string;
      player: VideoPlayer;
    }) {
      useVideoPlaybackControl(props.player, false, props.loading);
      playback = useHlsPlayback(props.source, viewRef, props.player, props.fallback);
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe, { source, loading, fallback, player }));
    });
    if (!renderer || !playback) throw new Error('Decoder probe did not mount');
    const tree = renderer;
    mounted.push(tree);
    const handle = { nativeRef: { current: element } } as unknown as VideoViewHandle;
    await act(async () => {
      playback?.ref(handle);
    });
    return {
      element,
      player,
      handle,
      ref: (value: VideoViewHandle | null) => playback?.ref(value),
      update: async (next: {
        source?: string;
        loading?: boolean;
        fallback?: string;
        player?: VideoPlayer;
      }) => {
        await act(async () =>
          tree.update(createElement(Probe, { source, loading, fallback, player, ...next })),
        );
      },
      unmount: async () => {
        await act(async () => tree.unmount());
      },
    };
  }

  it('defers the manifest until demanded, resumes buffered loading and releases on unmount', async () => {
    const probe = await mountDecoder();
    const decoder = mockHlsInstances[0];
    expect(decoder.attachMedia).toHaveBeenCalledWith(probe.element);
    expect(decoder.loadSource).not.toHaveBeenCalled();
    await probe.update({ loading: true });
    expect(decoder.loadSource).toHaveBeenCalledTimes(1);
    expect(decoder.loadSource).toHaveBeenCalledWith(LADDER);
    expect(decoder.startLoad).toHaveBeenLastCalledWith(-1);
    await probe.update({ loading: false });
    expect(decoder.stopLoad).toHaveBeenCalledTimes(2);
    await probe.update({ loading: true });
    expect(decoder.loadSource).toHaveBeenCalledTimes(1);
    expect(decoder.startLoad).toHaveBeenCalledTimes(2);
    await act(async () => {
      probe.ref(null);
      probe.ref(probe.handle);
    });
    expect(mockHlsInstances).toHaveLength(1);
    expect(decoder.destroy).not.toHaveBeenCalled();
    function Demand({ loading }: { loading: boolean }) {
      useVideoPlaybackControl(probe.player, false, loading);
      return null;
    }
    let publisher: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      publisher = TestRenderer.create(createElement(Demand, { loading: true }));
    });
    if (!publisher) throw new Error('Demand presenter did not mount');
    const demand = publisher;
    mounted.push(demand);
    await probe.unmount();
    expect(decoder.destroy).toHaveBeenCalledTimes(1);
    const starts = decoder.startLoad.mock.calls.length;
    const stops = decoder.stopLoad.mock.calls.length;
    await act(async () => demand.update(createElement(Demand, { loading: false })));
    await act(async () => demand.update(createElement(Demand, { loading: true })));
    expect(decoder.startLoad).toHaveBeenCalledTimes(starts);
    expect(decoder.stopLoad).toHaveBeenCalledTimes(stops);
  });

  it('replaces a decoder for a changed source or player and detaches for progressive playback', async () => {
    const probe = await mountDecoder(LADDER, true);
    const original = mockHlsInstances[0];
    const second = 'https://cloud.oxy.so/m2?variant=hls_master';
    await probe.update({ source: second, loading: true });
    expect(original.destroy).toHaveBeenCalledTimes(1);
    expect(mockHlsInstances[1].loadSource).toHaveBeenCalledWith(second);
    await probe.update({ source: second, loading: true, player: fakePlayer() });
    expect(mockHlsInstances[1].destroy).toHaveBeenCalledTimes(1);
    expect(mockHlsInstances[2].loadSource).toHaveBeenCalledWith(second);
    await probe.update({ source: ORIGINAL });
    expect(mockHlsInstances[2].destroy).toHaveBeenCalledTimes(1);
    expect(mockHlsInstances).toHaveLength(3);
  });

  it('uses the current progressive fallback after a fatal error and stops observing demand', async () => {
    const probe = await mountDecoder(LADDER, true, ORIGINAL);
    const decoder = mockHlsInstances[0];
    await probe.update({ loading: true, fallback: 'https://cloud.oxy.so/new-original' });
    expect(mockHlsInstances).toHaveLength(1);
    await act(async () => decoder.emitError(false));
    expect(decoder.destroy).not.toHaveBeenCalled();
    Object.defineProperty(probe.element, 'paused', { value: false });
    await act(async () => decoder.emitError(true));
    expect(decoder.destroy).toHaveBeenCalledTimes(1);
    expect(probe.element.src).toBe('https://cloud.oxy.so/new-original');
    expect(probe.element.play).toHaveBeenCalledTimes(1);
    const starts = decoder.startLoad.mock.calls.length;
    const stops = decoder.stopLoad.mock.calls.length;
    await probe.update({ loading: false });
    await probe.update({ loading: true });
    expect(decoder.startLoad).toHaveBeenCalledTimes(starts);
    expect(decoder.stopLoad).toHaveBeenCalledTimes(stops);
    await probe.unmount();
    expect(decoder.destroy).toHaveBeenCalledTimes(1);
  });

  it('stops a fatal stream without trying a missing fallback', async () => {
    const probe = await mountDecoder(LADDER, true);
    const decoder = mockHlsInstances[0];
    await act(async () => decoder.emitError(true));
    expect(decoder.destroy).toHaveBeenCalledTimes(1);
    expect(probe.element.play).not.toHaveBeenCalled();
    expect(probe.element.getAttribute('src')).toBeNull();
  });
});

it('does not attach a decoder when the view unmounts before its lazy import resolves', async () => {
  withMediaSource(true);
  const player = fakePlayer();
  const viewRef = { current: null };
  let playback: ReturnType<typeof useHlsPlayback> | undefined;
  function Probe() {
    playback = useHlsPlayback(LADDER, viewRef, player);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Probe));
  });
  act(() => {
    playback?.ref({
      nativeRef: { current: document.createElement('video') },
    } as unknown as VideoViewHandle);
  });
  act(() => {
    renderer?.unmount();
  });
  await act(async () => {});
  expect(mockHlsInstances).toHaveLength(0);
});
