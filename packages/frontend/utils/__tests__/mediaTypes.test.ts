import { readMediaPixelSize } from '../mediaTypes';

/**
 * The intrinsic pixel size the feed persists, which is what gives the Android
 * Picture-in-Picture window its shape before playback has reported a track — see
 * `usePipAspectRatio`. Its job is to decline politely: anything the OS would reject
 * has to come back `undefined` here rather than reaching the native call.
 */
describe('readMediaPixelSize', () => {
  it('reads a portrait size', () => {
    expect(readMediaPixelSize({ width: 1080, height: 1920 })).toEqual({ width: 1080, height: 1920 });
  });

  it('needs BOTH axes — one alone says nothing about shape', () => {
    expect(readMediaPixelSize({ width: 1080 })).toBeUndefined();
    expect(readMediaPixelSize({ height: 1920 })).toBeUndefined();
  });

  it('declines media the backend has not backfilled', () => {
    expect(readMediaPixelSize(undefined)).toBeUndefined();
    expect(readMediaPixelSize({})).toBeUndefined();
  });

  it('declines a non-positive axis, which the OS rejects', () => {
    // What a player reports before it has decoded a frame, and what a bad ingest
    // can persist. `Rational(0, 0)` is exactly the value that lands a reel in a
    // landscape window.
    expect(readMediaPixelSize({ width: 0, height: 0 })).toBeUndefined();
    expect(readMediaPixelSize({ width: 1080, height: 0 })).toBeUndefined();
    expect(readMediaPixelSize({ width: -1080, height: 1920 })).toBeUndefined();
  });

  it('declines a non-finite axis rather than passing NaN along', () => {
    expect(readMediaPixelSize({ width: Number.NaN, height: 1920 })).toBeUndefined();
    expect(readMediaPixelSize({ width: 1080, height: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('does not reconstruct a size from the stored aspect ratio', () => {
    // A ratio cannot be turned back into pixels, and inventing a pair would hand the
    // window a made-up size that happens to have the right shape — fine by luck,
    // wrong as a contract.
    expect(readMediaPixelSize({ aspectRatio: 0.5625 })).toBeUndefined();
  });
});
