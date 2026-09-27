/** @jest-environment jsdom */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { URL as NodeURL } from 'node:url';
import { Platform } from 'react-native';
import { useProfileSEOPolicy } from '../useProfileSEOPolicy';
import { releaseServerSEO } from '@/lib/seoHandoff';
import { SEOHandoff } from '@/components/SEOHandoff';

let mockPathname = '/@alias';
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('@/config', () => ({ INSTANCE_NAME: 'Managed Mention' }));

type Visibility = Parameters<typeof useProfileSEOPolicy>[0];
let latest: ReturnType<typeof useProfileSEOPolicy>;
let tree: TestRenderer.ReactTestRenderer | undefined;
function Probe({ visibility }: { visibility: Visibility }) {
  const value = useProfileSEOPolicy(visibility);
  React.useEffect(() => { latest = value; }, [value]);
  return null;
}
function render(visibility: Visibility) {
  act(() => {
    const element = <Probe visibility={visibility} />;
    if (tree) tree.update(element);
    else tree = TestRenderer.create(element);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'URL', { configurable: true, writable: true, value: NodeURL });
  mockPathname = '/@alias';
  Platform.OS = 'web';
  window.history.replaceState(null, '', '/@alias');
  document.head.innerHTML = '<title data-mention-seo="true">Initial alias</title><link data-mention-seo="true" rel="canonical" href="https://mention.earth/@primary"><meta data-mention-seo="true" name="robots" content="noindex,nofollow">';
  document.body.innerHTML = '<div id="root">Application content</div>';
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

test('retains restrictive server proof through DOM adoption and alias canonicalization', () => {
  render(undefined);
  expect(latest.robots).toBe('noindex,nofollow');
  expect(latest.server?.url).toBe('https://mention.earth/@primary');
  releaseServerSEO(document);
  render('public');
  expect(latest.detailsAllowed).toBe(false);
  expect(latest.robots).toBe('noindex,nofollow');
  mockPathname = '/@primary';
  render('public');
  expect(latest.server?.url).toBe('https://mention.earth/@primary');
  mockPathname = '/@another';
  render(undefined);
  expect(latest.server).toBeUndefined();
  expect(latest.robots).toBe('noindex,nofollow');
});

test('client-only profiles require explicit public privacy and tighten immediately on restriction', () => {
  releaseServerSEO(document);
  render(undefined);
  expect(latest.detailsAllowed).toBe(false);
  expect(latest.robots).toBe('noindex,nofollow');
  render('public');
  expect(latest.detailsAllowed).toBe(true);
  expect(latest.robots).toBe('index,follow');
  render('followers_only');
  expect(latest.detailsAllowed).toBe(false);
  expect(latest.robots).toBe('noindex,nofollow');
});

test('native profiles never adopt a web server document', () => {
  Platform.OS = 'ios';
  render('public');
  expect(latest.server).toBeUndefined();
  expect(document.querySelector('link[data-mention-seo]')).not.toBeNull();
});

test('the root bridge preserves alias boot and releases the initial document on real navigation', () => {
  act(() => { tree = TestRenderer.create(<SEOHandoff />); });
  expect(document.querySelector('link[data-mention-seo]')).not.toBeNull();
  mockPathname = '/@primary';
  act(() => { tree!.update(<SEOHandoff />); });
  expect(document.querySelector('link[data-mention-seo]')).not.toBeNull();
  mockPathname = '/explore';
  window.history.replaceState(null, '', '/explore');
  act(() => { tree!.update(<SEOHandoff />); });
  expect(document.querySelector('link[data-mention-seo]')).toBeNull();
  expect(document.title).toBe('Managed Mention');
});

test('the native root bridge leaves the document alone', () => {
  Platform.OS = 'ios';
  act(() => { tree = TestRenderer.create(<SEOHandoff />); });
  expect(document.querySelector('link[data-mention-seo]')).not.toBeNull();
});
