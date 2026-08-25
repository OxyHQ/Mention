import { measurePanelSurface, registerPanelSurface } from '../panelSurface';

/**
 * The shell publishing where a route will paint, for callers that have to aim
 * at a route before it exists.
 *
 * Every case here is a way the answer can be WRONG rather than absent, because
 * absent is safe: a caller that gets `null` falls back to the window, which is
 * what shipped before. A caller that gets a plausible-but-wrong rect flies a
 * video to the wrong place and nothing complains — which is exactly what
 * happened when the destination was the window on desktop.
 */

interface FakeNode {
  measureInWindow(cb: (x: number, y: number, w: number, h: number) => void): void;
}

const nodeAt = (x: number, y: number, w: number, h: number): FakeNode => ({
  measureInWindow: (cb) => cb(x, y, w, h),
});

afterEach(() => registerPanelSurface(null));

describe('measurePanelSurface', () => {
  it('resolves null when nothing has registered', async () => {
    await expect(measurePanelSurface()).resolves.toBeNull();
  });

  it('reports the registered node in window coordinates', async () => {
    registerPanelSurface(nodeAt(358, 0, 592, 900));

    await expect(measurePanelSurface()).resolves.toEqual({ x: 358, y: 0, width: 592, height: 900 });
  });

  it('treats a zero-area node as no answer', async () => {
    // A node that is laid out but not yet on screen measures zero. Returning
    // that would collapse whatever aimed at it to a point, so it has to read
    // the same as "nothing registered" rather than as a rect.
    registerPanelSurface(nodeAt(0, 0, 0, 0));
    await expect(measurePanelSurface()).resolves.toBeNull();

    registerPanelSurface(nodeAt(358, 0, 592, 0));
    await expect(measurePanelSurface()).resolves.toBeNull();
  });

  it('forgets the node when the panel unmounts', async () => {
    registerPanelSurface(nodeAt(358, 0, 592, 900));
    registerPanelSurface(null);

    // The callback ref fires with null on unmount, and a stale node would keep
    // answering with a box that is no longer on screen.
    await expect(measurePanelSurface()).resolves.toBeNull();
  });

  it('answers with the most recent panel, not the first', async () => {
    registerPanelSurface(nodeAt(0, 0, 415, 932));
    registerPanelSurface(nodeAt(358, 0, 592, 900));

    await expect(measurePanelSurface()).resolves.toEqual({ x: 358, y: 0, width: 592, height: 900 });
  });

  it('measures at call time, so a resized window is not replayed from the old one', async () => {
    let width = 415;
    registerPanelSurface({ measureInWindow: (cb) => cb(0, 0, width, 932) });

    await expect(measurePanelSurface()).resolves.toEqual({ x: 0, y: 0, width: 415, height: 932 });
    width = 592;
    await expect(measurePanelSurface()).resolves.toEqual({ x: 0, y: 0, width: 592, height: 932 });
  });
});
