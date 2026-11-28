/**
 * The server-rendered first frame of a public post or profile page
 * (`backend/src/services/webshell/prerender.ts`): a fixed layer over `#root`
 * that shows the page while the app boots underneath it.
 *
 * The app removes it once the route has committed the same content — the
 * moment its `<SEO ready>` adopts the server's head (`components/SEO.tsx`) —
 * after two frames, so the app's screen is painted before the layer fades.
 * It is also removed when the reader navigates elsewhere before that, and in
 * any case a few seconds after the app has mounted, so a route that never
 * becomes ready (an error, a redirect) can never stay hidden behind it.
 */

const LAYER_ID = 'mention-prerender';
/** The layer's own fade (`.mp-leaving`, 160 ms) plus a margin. */
const FADE_MS = 200;
/**
 * After the route is ready, how long to wait for its heading to be on screen.
 * The post and profile screens both render their `<h1>` (the author, the
 * profile's name) with the content; a virtualized list can draw it a frame or
 * more after the commit that made the route ready.
 */
const CONTENT_WAIT_MS = 1500;
/** After the app mounts, the longest the layer may stay. */
export const PRERENDER_MAX_HOLD_MS = 8000;

let released = false;

function layer(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(LAYER_ID);
}

/** Whether the document carries a first frame the app has not released yet. */
export function hasPrerender(): boolean {
  return !released && layer() !== null;
}

/** Fade the first frame out and remove it, once. */
export function releasePrerender(): void {
  if (released) return;
  const node = layer();
  if (!node) return;
  released = true;
  const remove = () => {
    node.remove();
    document.getElementById(`${LAYER_ID}-style`)?.remove();
  };
  const raf =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: () => void) => setTimeout(callback, 16);
  const fade = () => {
    node.classList.add('mp-leaving');
    setTimeout(remove, FADE_MS);
  };
  const startedAt = Date.now();
  // Wait for the route's own heading, then two frames so it has been painted.
  const whenPainted = () => {
    if (document.querySelector('#root h1') || Date.now() - startedAt > CONTENT_WAIT_MS) {
      raf(() => raf(fade));
      return;
    }
    raf(whenPainted);
  };
  whenPainted();
}

/**
 * Arm the safety release when the app mounts: the layer never outlives
 * {@link PRERENDER_MAX_HOLD_MS}. Returns the disarm for an unmount.
 */
export function armPrerenderRelease(): () => void {
  if (!hasPrerender()) return () => undefined;
  const timer = setTimeout(releasePrerender, PRERENDER_MAX_HOLD_MS);
  return () => clearTimeout(timer);
}

/** Tests only. */
export function resetPrerenderForTests(): void {
  released = false;
}
