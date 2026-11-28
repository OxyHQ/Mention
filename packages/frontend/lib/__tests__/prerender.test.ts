/** @jest-environment jsdom */
import {
  PRERENDER_MAX_HOLD_MS,
  armPrerenderRelease,
  hasPrerender,
  releasePrerender,
  resetPrerenderForTests,
} from '../prerender';

beforeEach(() => {
  jest.useFakeTimers();
  resetPrerenderForTests();
  document.head.innerHTML = '<style id="mention-prerender-style"></style>';
  document.body.innerHTML =
    '<div id="mention-prerender" data-mention-prerender><h1>Nate</h1></div><div id="root"></div>';
});

afterEach(() => {
  jest.useRealTimers();
});

function rootHeading() {
  document.getElementById('root')!.innerHTML = '<h1>Nate</h1>';
}

test("the first frame stays until the route's own heading is on screen, then fades out", () => {
  expect(hasPrerender()).toBe(true);
  releasePrerender();
  jest.advanceTimersByTime(100);
  // The app has not drawn its heading yet: the layer is still there.
  expect(document.getElementById('mention-prerender')?.classList.contains('mp-leaving')).toBe(
    false,
  );
  rootHeading();
  jest.advanceTimersByTime(100);
  expect(document.getElementById('mention-prerender')?.classList.contains('mp-leaving')).toBe(true);
  jest.advanceTimersByTime(300);
  expect(document.getElementById('mention-prerender')).toBeNull();
  expect(document.getElementById('mention-prerender-style')).toBeNull();
  expect(hasPrerender()).toBe(false);
});

test('a route that never draws its heading still hands over', () => {
  releasePrerender();
  jest.advanceTimersByTime(4000);
  expect(document.getElementById('mention-prerender')).toBeNull();
});

test('the first frame never outlives the boot, whatever the route does', () => {
  const disarm = armPrerenderRelease();
  rootHeading();
  jest.advanceTimersByTime(PRERENDER_MAX_HOLD_MS + 500);
  expect(document.getElementById('mention-prerender')).toBeNull();
  disarm();
});

test('a document without a first frame is left alone', () => {
  document.body.innerHTML = '<div id="root"></div>';
  expect(hasPrerender()).toBe(false);
  expect(() => releasePrerender()).not.toThrow();
  armPrerenderRelease()();
});

test('the frame waits for the images the app shows on screen', () => {
  rootHeading();
  const image = document.createElement('img');
  Object.defineProperty(image, 'complete', { configurable: true, value: false });
  image.getBoundingClientRect = () => ({ top: 0, bottom: 170, width: 412, height: 170 }) as DOMRect;
  document.getElementById('root')!.appendChild(image);
  releasePrerender();
  jest.advanceTimersByTime(200);
  expect(document.getElementById('mention-prerender')?.classList.contains('mp-leaving')).toBe(
    false,
  );
  Object.defineProperty(image, 'complete', { configurable: true, value: true });
  jest.advanceTimersByTime(200);
  expect(document.getElementById('mention-prerender')?.classList.contains('mp-leaving')).toBe(true);
});
