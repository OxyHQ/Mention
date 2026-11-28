/** @jest-environment jsdom */
import { isPreloadedLcpImage, resetPreloadedLcpImageForTests } from '../lcpImage';

afterEach(() => {
  document.head.innerHTML = '';
  resetPreloadedLcpImageForTests();
});

test('only the image the document preloaded as its LCP loads eagerly', () => {
  document.head.innerHTML =
    '<link rel="preload" as="image" href="https://cloud.oxy.so/a?variant=w320" fetchpriority="high" data-mention-lcp>';
  expect(isPreloadedLcpImage('https://cloud.oxy.so/a?variant=w320')).toBe(true);
  expect(isPreloadedLcpImage('https://cloud.oxy.so/b?variant=w320')).toBe(false);
});

test('a document without an LCP preload keeps every image lazy', () => {
  document.head.innerHTML = '<link rel="preload" as="image" href="https://cloud.oxy.so/a">';
  expect(isPreloadedLcpImage('https://cloud.oxy.so/a')).toBe(false);
});
