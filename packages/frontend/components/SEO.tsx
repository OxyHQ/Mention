import React, { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, usePathname } from 'expo-router';
import { releaseServerSEO } from '@/lib/seoHandoff';
import { WEB_BASE_URL } from '@/config';
import ExpoHead from 'expo-router/head';
import { useTranslation } from 'react-i18next';

export interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: 'website' | 'article' | 'profile';
  siteName?: string;
  twitterHandle?: string;
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
  /** Keep the server document until equivalent route content has committed. */
  ready?: boolean;
  robots?: string;
  jsonLd?: Record<string, unknown>;
}

const defaultSEO = {
  siteName: 'Mention',
  twitterHandle: '@mention',
  type: 'website' as const,
  imageAlt: 'Illustration of friends and a dog gathered around the Mention logo under a blue sky.',
};

/**
 * What the default social image is, stated next to it: dimensions, type and alt
 * text. Only the default image has these — an entity's own image (a profile's
 * avatar, a post's media) has sizes this component does not know, and a card
 * must not claim the homepage's 1280x720 for it.
 */
const DEFAULT_IMAGE_TAGS: ReadonlyArray<readonly ['property' | 'name', string, string]> = [
  ['property', 'og:image:width', '1280'],
  ['property', 'og:image:height', '720'],
  ['property', 'og:image:type', 'image/jpeg'],
  ['property', 'og:image:alt', defaultSEO.imageAlt],
  ['name', 'twitter:image:alt', defaultSEO.imageAlt],
];

/** Marks the nodes {@link useDefaultImageTags} owns, so it never touches anyone else's. */
export const DEFAULT_IMAGE_TAG_MARKER = 'data-mention-default-og';

/** The exported homepage and runtime share the same real public asset. */
const DEFAULT_IMAGE = `${WEB_BASE_URL.replace(/\/$/, '')}/og-image.jpg`;

/**
 * Make the default image's descriptors match the image the head ACTUALLY
 * advertises: present exactly when the head component's `og:image` is the
 * default image, absent otherwise. Idempotent, so it may run on every head
 * mutation, its own included.
 *
 * Only the head component's `og:image` (`data-rh`) counts. The server's own
 * `og:image` (`data-mention-seo`) comes with its own descriptors, and is
 * released once the route's metadata has committed.
 */
export function syncDefaultImageTags(head: HTMLHeadElement): void {
  const image = head.querySelector('meta[property="og:image"][data-rh]')?.getAttribute('content');
  const owned = head.querySelectorAll(`meta[${DEFAULT_IMAGE_TAG_MARKER}]`);
  const wanted = image === DEFAULT_IMAGE;
  if (owned.length === (wanted ? DEFAULT_IMAGE_TAGS.length : 0)) return;
  owned.forEach((node) => node.remove());
  if (!wanted) return;
  for (const [attribute, key, content] of DEFAULT_IMAGE_TAGS) {
    const node = head.ownerDocument.createElement('meta');
    node.setAttribute(attribute, key);
    node.setAttribute('content', content);
    node.setAttribute(DEFAULT_IMAGE_TAG_MARKER, 'true');
    head.appendChild(node);
  }
}

/** One head observer, shared by every mounted SEO instance. */
let headWatch: { observer: MutationObserver; users: number } | undefined;

/**
 * The default image's descriptors (width, height, type, alt), kept in step
 * with the document's `og:image` rather than owned by any one screen.
 *
 * They cannot be ordinary head-component tags: the head component (expo-router's
 * vendored react-helmet-async) resolves each tag to the NEWEST instance that
 * declares it, and only the default image has these five, so an older screen
 * still mounted under the current one (the home tab under a profile) kept its
 * 1280x720 on the profile's avatar card (#1225).
 *
 * Nor can a screen own them. A stacked screen stays mounted under the one
 * pushed over it, and which screen's `og:image` the head shows is decided by
 * the head component, not by React commit order: when a profile first
 * described the default image and then stopped (its avatar arrived, or it
 * went back to loading), the home screen under it was left advertising the
 * default image with no descriptors at all — the release gate's
 * `seo-handoff.spec.ts` "transfers ownership on profile navigation". The only
 * reliable signal is the head itself, so they follow it: observed, and
 * re-derived on every change.
 */
function useDefaultImageTags(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return undefined;
    const head = document.head;
    if (!headWatch) {
      const observer = new MutationObserver(() => syncDefaultImageTags(head));
      observer.observe(head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content'] });
      headWatch = { observer, users: 0 };
    }
    headWatch.users += 1;
    syncDefaultImageTags(head);
    return () => {
      if (!headWatch || --headWatch.users > 0) return;
      headWatch.observer.disconnect();
      headWatch = undefined;
      head.querySelectorAll(`meta[${DEFAULT_IMAGE_TAG_MARKER}]`).forEach((node) => node.remove());
    };
  }, [enabled]);
}

export const SEO: React.FC<SEOProps> = ({
  title,
  description,
  image,
  url,
  type = 'website',
  siteName,
  twitterHandle = defaultSEO.twitterHandle,
  author,
  publishedTime,
  modifiedTime,
  ready = true,
  robots = 'index,follow',
  jsonLd,
}) => {
  const pathname = usePathname();
  const { t } = useTranslation();
  
  // Generate full URL
  const fullUrl = url || (Platform.OS === 'web' && typeof window !== 'undefined' 
    ? `${window.location.origin}${pathname}`
    : `https://mention.earth${pathname}`);

  // Use provided siteName or translated default
  const finalSiteName = siteName || t('seo.siteName', { defaultValue: defaultSEO.siteName });
  
  // Default title if not provided (translated)
  const pageTitle = title || t('seo.defaultTitle', { defaultValue: `${finalSiteName} - Social Platform` });
  
  // Default description if not provided (translated)
  const pageDescription = description || t('seo.defaultDescription', { 
    defaultValue: `Join ${finalSiteName} and connect with people around the world.`,
    siteName: finalSiteName
  });

  const pageImage = image || DEFAULT_IMAGE;

  useDefaultImageTags(Platform.OS === 'web');

  useFocusEffect(useCallback(() => {
    if (Platform.OS === 'web' && ready && typeof document !== 'undefined') {
      releaseServerSEO(document);
    }
  }, [ready]));

  // Loading routes must not overwrite complete server metadata with placeholders.
  if (Platform.OS !== 'web' || !ready) {
    return null;
  }

  return (
    <ExpoHead>
      {/* Primary Meta Tags */}
      <title>{pageTitle}</title>
      <meta name="title" content={pageTitle} />
      <meta name="description" content={pageDescription} />
      <meta name="robots" content={robots} />
      {jsonLd && <script type="application/ld+json">{JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>}
      
      {/* Open Graph / Facebook */}
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={pageDescription} />
      <meta property="og:image" content={pageImage} />
      {/* The default image's width/height/type/alt: `useDefaultImageTags`. */}
      <meta property="og:site_name" content={finalSiteName} />
      
      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={fullUrl} />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={pageDescription} />
      <meta name="twitter:image" content={pageImage} />
      {twitterHandle && <meta name="twitter:site" content={twitterHandle} />}
      {twitterHandle && <meta name="twitter:creator" content={twitterHandle} />}
      
      {/* Article specific tags */}
      {type === 'article' && (
        <>
          {author && <meta property="article:author" content={author} />}
          {publishedTime && <meta property="article:published_time" content={publishedTime} />}
          {modifiedTime && <meta property="article:modified_time" content={modifiedTime} />}
        </>
      )}
      
      {/* Additional meta tags */}
      <link rel="canonical" href={fullUrl} />
    </ExpoHead>
  );
};

export default SEO;
