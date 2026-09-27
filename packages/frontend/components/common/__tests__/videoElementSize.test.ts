import { findVideoElement, watchVideoSize, type VideoElementLike } from '../videoElementSize';

/**
 * A web video with no stored dimensions learns its shape from the <video>
 * element (expo-video's web player reports no track sizes). Production,
 * 2026-09-27: without it an Instagram Reel read before its dimensions were
 * collected had no shape to size its card with.
 */

function fakeVideo(size: { width: number; height: number; readyState: number }) {
  const listeners = new Set<() => void>();
  const video = {
    videoWidth: size.width,
    videoHeight: size.height,
    readyState: size.readyState,
    addEventListener: (_type: 'loadedmetadata', listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: 'loadedmetadata', listener: () => void) => { listeners.delete(listener); },
  };
  return {
    video: video as VideoElementLike,
    loadMetadata(width: number, height: number) {
      video.videoWidth = width;
      video.videoHeight = height;
      video.readyState = 1;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

describe('watchVideoSize', () => {
  it('reports the size once metadata loads, and stops on unsubscribe', () => {
    const { video, loadMetadata, listenerCount } = fakeVideo({ width: 0, height: 0, readyState: 0 });
    const onSize = jest.fn();

    const stop = watchVideoSize(video, onSize);
    expect(onSize).not.toHaveBeenCalled();

    loadMetadata(720, 1280);
    expect(onSize).toHaveBeenCalledWith(720, 1280);

    stop();
    expect(listenerCount()).toBe(0);
  });

  it('reports at once when the metadata already loaded (the event is past)', () => {
    const { video } = fakeVideo({ width: 1080, height: 1920, readyState: 4 });
    const onSize = jest.fn();
    watchVideoSize(video, onSize);
    expect(onSize).toHaveBeenCalledWith(1080, 1920);
  });

  it('never reports a zero size', () => {
    const { video } = fakeVideo({ width: 0, height: 0, readyState: 4 });
    const onSize = jest.fn();
    watchVideoSize(video, onSize);
    expect(onSize).not.toHaveBeenCalled();
  });
});

describe('findVideoElement', () => {
  const { video } = fakeVideo({ width: 1, height: 1, readyState: 0 });

  it("prefers the VideoView's own element (what HLS attaches to)", () => {
    const querySelector = jest.fn();
    expect(findVideoElement({ nativeRef: { current: video } }, { querySelector })).toBe(video);
    expect(querySelector).not.toHaveBeenCalled();
  });

  it('falls back to the <video> inside the player container', () => {
    expect(findVideoElement(null, { querySelector: (selector: string) => (selector === 'video' ? video : null) })).toBe(video);
  });

  it('answers null when there is no video element (native, or not mounted yet)', () => {
    expect(findVideoElement({ nativeRef: { current: {} } }, null)).toBeNull();
    expect(findVideoElement(undefined, { querySelector: () => null })).toBeNull();
  });
});
