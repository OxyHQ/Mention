import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('SEOHandoff');

const documentPaths = new WeakMap<Document, string>();

/** Capture before the router can navigate; the canonical may name a proven alias. */
export function initialSEODocumentPath(document: Document): string {
  let pathname = documentPaths.get(document);
  if (pathname === undefined) {
    pathname = new URL(document.URL).pathname;
    documentPaths.set(document, pathname);
  }
  return pathname;
}

/** Only the backend marks these nodes; ExpoHead owns its own lifecycle. */
export function releaseServerSEO(document: Document): void {
  document.head.querySelectorAll('[data-mention-seo="true"]')
    .forEach((node) => {
      // Helmet updates document.title in place: do not delete the adopted title.
      if (node.tagName === 'TITLE') node.removeAttribute('data-mention-seo');
      else node.remove();
    });
}

/** Compare decoded segments without confusing an encoded slash with a separator. */
function pathKey(pathname: string): string {
  return JSON.stringify(pathname.replace(/\/+$/, '').split('/').map((segment) => {
    try { return decodeURIComponent(segment); }
    catch {
      logger.warn('Malformed route encoding in SEO handoff');
      return segment;
    }
  }));
}

export function matchesSEOPath(url: string, pathname: string): boolean {
  try { return pathKey(new URL(url).pathname) === pathKey(pathname); }
  catch {
    logger.warn('Invalid server canonical in SEO handoff');
    return false;
  }
}

export function releaseServerSEOForNavigation(
  document: Document,
  pathname: string,
  initialTitle?: string,
  siteName = 'Mention',
): void {
  const canonical = document.querySelector<HTMLLinkElement>('link[data-mention-seo="true"][rel="canonical"]');
  const initialUrl = canonical?.href;
  if (!initialUrl) return;
  const initialPath = initialSEODocumentPath(document);
  if (pathKey(initialPath) !== pathKey(pathname) && !matchesSEOPath(initialUrl, pathname)) {
    const serverTitle = document.querySelector('title[data-mention-seo="true"]');
    // Helmet may already have updated this very node for the destination.
    // Reset only an unchanged initial title when nobody has adopted it yet.
    const resetTitle = initialTitle !== undefined && serverTitle?.textContent === initialTitle;
    releaseServerSEO(document);
    if (resetTitle) document.title = siteName;
  }
}

/** The hydrated post DTO does not contain every discovery/privacy safety flag. */
export function readServerSEO(document: Document, pathname: string) {
  const canonical = document.querySelector<HTMLLinkElement>('link[data-mention-seo="true"][rel="canonical"]');
  const documentPath = initialSEODocumentPath(document);
  if (!canonical || (pathKey(documentPath) !== pathKey(pathname) && !matchesSEOPath(canonical.href, pathname))) return undefined;
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(`meta[data-mention-seo="true"]${selector}`)?.content;
  const structured = document.querySelector('script[data-mention-seo="true"][type="application/ld+json"]')?.textContent;
  let jsonLd: Record<string, unknown> | undefined;
  try { jsonLd = structured ? JSON.parse(structured) : undefined; } catch { logger.warn('Invalid server structured metadata; omitted during handoff'); }
  return {
    url: canonical.href,
    documentPath,
    title: document.title,
    description: meta('[name="description"]'),
    image: meta('[property="og:image"]'),
    robots: meta('[name="robots"]') || 'noindex,nofollow',
    jsonLd,
  };
}


export function matchesServerSEOPath(server: ReturnType<typeof readServerSEO>, pathname: string): boolean {
  return Boolean(server && (pathKey(server.documentPath) === pathKey(pathname) || matchesSEOPath(server.url, pathname)));
}


export function profileSEOPolicy(
  visibility: 'public' | 'private' | 'followers_only' | undefined,
  server?: ReturnType<typeof readServerSEO>,
) {
  const restricted = visibility === 'private' || visibility === 'followers_only';
  const authoritative = restricted ? undefined : server;
  // Missing appearance data is UNKNOWN, including failed reads. Only explicit
  // public privacy can authorize fresh bio/image/schema from the client DTO.
  const detailsAllowed = visibility === 'public' && !server?.robots.startsWith('noindex');
  return {
    detailsAllowed,
    server: authoritative,
    robots: restricted ? 'noindex,nofollow' : authoritative?.robots || (detailsAllowed ? 'index,follow' : 'noindex,nofollow'),
  };
}
