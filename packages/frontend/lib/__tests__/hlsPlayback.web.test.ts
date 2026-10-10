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
import { needsJsHlsDecoder, playProgressiveInstead } from '../hlsPlayback.web';

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
