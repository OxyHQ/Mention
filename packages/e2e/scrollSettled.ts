import type { Locator, Page } from '@playwright/test';

/**
 * Resolve once the document has stopped scrolling and every scroll event it
 * produced has been delivered to the page.
 *
 * Playwright scrolls a target into view and returns immediately, but the browser
 * dispatches the resulting `scroll` event on a later rendering step.
 * react-native-web terminates the active press responder on any document
 * `scroll` ("native scroll without using a pointer"), exactly as a native scroll
 * view cancels a touch. A `mouse.down()` issued in between is therefore
 * cancelled by the harness's own scroll, its long-press timer never fires, and
 * the app has done nothing wrong. Scroll position holding across consecutive
 * frames is the observable "nothing will scroll under the pointer any more"
 * condition.
 */
export async function scrollSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = Number.NaN;
        let stable = 0;
        const frame = () => {
          const y = window.scrollY;
          stable = y === last ? stable + 1 : 0;
          last = y;
          if (stable >= 2) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/** Hover a target, then wait until the scroll that brought it into view is over. */
export async function hoverSettled(page: Page, target: Locator): Promise<void> {
  await target.hover();
  await scrollSettled(page);
}
