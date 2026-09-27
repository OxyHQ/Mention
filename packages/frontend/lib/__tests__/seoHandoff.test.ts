/** @jest-environment jsdom */
import { URL as NodeURL } from 'node:url';
import { matchesSEOPath, profileSEOPolicy, readServerSEO, releaseServerSEO, releaseServerSEOForNavigation } from '../seoHandoff';

beforeEach(() => {
  Object.defineProperty(globalThis, 'URL', { configurable: true, writable: true, value: NodeURL });
  document.head.innerHTML = `<title data-mention-seo="true">Nate on Mention</title>
    <link data-mention-seo="true" rel="canonical" href="https://mention.earth/@nate">
    <meta data-mention-seo="true" property="og:url" content="https://mention.earth/@nate">
    <script data-mention-seo="true" type="application/ld+json">{"@type":"ProfilePage"}</script>
    <link rel="manifest" href="/manifest.json">`;
  document.body.innerHTML = '<main data-mention-seo-fallback="true" data-mention-seo-url="https://mention.earth/@nate">Nate</main><div id="root"></div>';
});

test('keeps complete initial metadata and content while the same route loads', () => {
  releaseServerSEOForNavigation(document, '/@nate');
  expect(document.querySelector('[data-mention-seo-fallback]')?.textContent).toBe('Nate');
  expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  expect(document.querySelector('script[type="application/ld+json"]')).not.toBeNull();
});

test('handoff preserves title adopted by Helmet and its new canonical', () => {
  document.title = 'Nate (@nate) on Mention';
  const canonical = document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = 'https://mention.earth/@nate';
  canonical.setAttribute('data-rh', 'true');
  document.head.append(canonical);
  releaseServerSEO(document);
  expect(document.title).toBe('Nate (@nate) on Mention');
  expect(document.querySelectorAll('title')).toHaveLength(1);
  expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  expect(document.querySelector('[data-mention-seo-fallback]')).toBeNull();
  expect(document.querySelector('link[rel="manifest"]')).not.toBeNull();
});

test('navigation to a route without SEO removes old schema, canonical and fallback', () => {
  releaseServerSEOForNavigation(document, '/explore');
  expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
  expect(document.querySelector('[data-mention-seo-fallback]')).toBeNull();
  expect(document.querySelector('meta[property="og:url"]')).toBeNull();
  expect(document.querySelector('link[rel="canonical"]')).toBeNull();
  releaseServerSEOForNavigation(document, '/explore');
});

test('post adoption retains server noindex and sanitized metadata, never guessing from DTO visibility', () => {
  document.head.innerHTML = `<title data-mention-seo="true">Sensitive post</title>
    <link data-mention-seo="true" rel="canonical" href="https://mention.earth/p/123">
    <meta data-mention-seo="true" name="robots" content="noindex,nofollow">
    <meta data-mention-seo="true" name="description" content="Sensitive content">`;
  const seo = readServerSEO(document, '/p/123');
  expect(seo?.robots).toBe('noindex,nofollow');
  expect(seo?.description).toBe('Sensitive content');
  expect(seo?.jsonLd).toBeUndefined();
  expect(seo?.image).toBeUndefined();
  expect(readServerSEO(document, '/p/456')).toBeUndefined();
});


test('a route without SEO receives the instance title instead of the stale profile title', () => {
  releaseServerSEOForNavigation(document, '/settings', document.title, 'Managed Mention');
  expect(document.title).toBe('Managed Mention');
});

test('navigation never overwrites a destination title Helmet already adopted', () => {
  const initialTitle = document.title;
  document.title = 'Explore';
  releaseServerSEOForNavigation(document, '/explore', initialTitle, 'Managed Mention');
  expect(document.title).toBe('Explore');
});

test('malformed route escapes cannot crash the root handoff effect', () => {
  expect(() => releaseServerSEOForNavigation(document, '/%E0%A4%A')).not.toThrow();
  expect(document.querySelector('[data-mention-seo-fallback]')).toBeNull();
});


test('federated encoded handles and trailing slashes retain the matching initial document', () => {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!;
  canonical.href = 'https://mention.earth/@aida_quilcue%40x.com';
  releaseServerSEOForNavigation(document, '/@aida_quilcue@x.com/');
  expect(document.querySelector('[data-mention-seo-fallback]')).not.toBeNull();
  expect(matchesSEOPath('https://mention.earth/@a%2Fb', '/@a/b')).toBe(false);
});

test('pending or failed appearance privacy cannot authorize public bio, image or schema', () => {
  expect(profileSEOPolicy(undefined)).toMatchObject({ detailsAllowed: false, robots: 'noindex,nofollow' });
  expect(profileSEOPolicy('public')).toMatchObject({ detailsAllowed: true, robots: 'index,follow' });
  const restricted = { url: 'https://mention.earth/@nate', title: 'Profile', robots: 'noindex,nofollow', description: undefined, image: undefined, jsonLd: undefined };
  expect(profileSEOPolicy(undefined, restricted)).toMatchObject({ detailsAllowed: false, robots: 'noindex,nofollow' });
  expect(profileSEOPolicy('public', restricted)).toMatchObject({ detailsAllowed: false, robots: 'noindex,nofollow' });
  expect(profileSEOPolicy('private', { ...restricted, robots: 'index,follow' })).toMatchObject({ detailsAllowed: false, robots: 'noindex,nofollow', server: undefined });
});
