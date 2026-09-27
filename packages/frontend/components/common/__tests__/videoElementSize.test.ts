import { findVideoElement } from '../videoElementSize';

/**
 * A web video with no stored dimensions learns its shape from the <video>
 * element (expo-video's web player reports no track sizes). Production,
 * 2026-09-27: without it an Instagram Reel read before its dimensions were
 * collected had no shape to size its card with.
 */
describe('findVideoElement', () => {
  const video = { videoWidth: 720, videoHeight: 1280 };

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
