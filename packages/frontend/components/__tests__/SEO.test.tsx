/**
 * @jest-environment jsdom
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { SEO } from '../SEO';

jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('expo-router', () => ({ usePathname: () => '/', useFocusEffect: jest.fn() }));
jest.mock('expo-router/head', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }));
jest.mock('@/config', () => ({ WEB_BASE_URL: 'https://social.example/' }));

let tree: TestRenderer.ReactTestRenderer;
afterEach(() => { act(() => tree?.unmount()); document.head.innerHTML = ''; });

/** The head as a map of property/name → content, from the real document. */
function head(): Record<string, string | null> {
  return Object.fromEntries([...document.head.querySelectorAll('meta')].map((node) => [
    node.getAttribute('property') ?? node.getAttribute('name') ?? '', node.getAttribute('content'),
  ]));
}

test('default social card advertises the real image with its dimensions and accessible description', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" />); });
  const meta = (key: string) => tree.root.findAllByType('meta').find(node => node.props.property === key || node.props.name === key)?.props.content;
  expect(meta('og:image')).toBe('https://social.example/og-image.jpg');
  expect(meta('twitter:image')).toBe(meta('og:image'));
  // The image's descriptors are written straight to the document (see below).
  expect(head()['og:image:width']).toBe('1280');
  expect(head()['og:image:height']).toBe('720');
  expect(head()['og:image:type']).toBe('image/jpeg');
  expect(head()['og:image:alt']).toContain('friends and a dog');
  expect(head()['twitter:image:alt']).toBe(head()['og:image:alt']);
});

test('personalized entity images do not inherit homepage image dimensions or description', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" image="https://cdn.example/avatar.png" robots="noindex,nofollow" />); });
  const nodes = tree.root.findAllByType('meta');
  expect(nodes.find(node => node.props.property === 'og:image')?.props.content).toBe('https://cdn.example/avatar.png');
  expect(nodes.find(node => node.props.name === 'robots')?.props.content).toBe('noindex,nofollow');
  expect(nodes.filter(node => ['og:image:width', 'og:image:height', 'og:image:type', 'og:image:alt', 'twitter:image:alt'].includes(node.props.property || node.props.name))).toHaveLength(0);
  expect(Object.keys(head()).filter((key) => key.startsWith('og:image:') || key === 'twitter:image:alt')).toEqual([]);
});

test('unready entity routes keep their existing server head', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" ready={false} />); });
  expect(tree.toJSON()).toBeNull();
});

/**
 * The release gate (seo-handoff "transfers ownership on profile navigation")
 * caught the homepage's 1280x720 and alt text surviving into a profile's head:
 * the head component registers an instance during render, so a discarded
 * homepage render left one behind for good. The descriptors now live only as
 * long as the screen that committed them.
 */
test("the default image's descriptors leave the head with the screen that wrote them", () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" />); });
  expect(head()['og:image:width']).toBe('1280');

  act(() => tree.unmount());
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/@someone" image="https://cdn.example/avatar.png" />); });

  expect(head()['og:image:width']).toBeUndefined();
  expect(head()['og:image:alt']).toBeUndefined();
  expect(head()['twitter:image:alt']).toBeUndefined();
});

test('two screens describing the default image never duplicate its tags', () => {
  let second!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" />); });
  act(() => { second = TestRenderer.create(<SEO url="https://social.example/search" />); });
  expect(document.head.querySelectorAll('meta[property="og:image:width"]')).toHaveLength(1);
  act(() => second.unmount());
});

test('an unready route writes no descriptors', () => {
  act(() => { tree = TestRenderer.create(<SEO url="https://social.example/" ready={false} />); });
  expect(head()).toEqual({});
});
