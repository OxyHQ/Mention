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

/**
 * The default image's descriptors, written by an EFFECT rather than through
 * the head component.
 *
 * The head component (expo-router's vendored react-helmet-async) registers an
 * instance during RENDER and forgets it only in `componentWillUnmount`. A render
 * React discards without committing — a suspended or superseded route render —
 * therefore leaves an instance behind for good, and its tags with it. Every
 * other tag here is declared by EVERY instance, so the newest one overwrites a
 * leaked copy; these five are declared only for the default image, so a leaked
 * homepage instance kept its 1280x720 and alt text on every page navigated to
 * next — a profile's avatar card claimed the homepage image's size (caught by
 * the release gate, `seo-handoff.spec.ts`). An effect runs only on commit and
 * always runs its cleanup, so these cannot outlive the screen that wrote them.
 */
function useDefaultImageTags(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    // One owner at a time: a second screen describing the default image
    // replaces the first one's nodes rather than duplicating them.
    document.head.querySelectorAll(`meta[${DEFAULT_IMAGE_TAG_MARKER}]`).forEach((node) => node.remove());
    const nodes = DEFAULT_IMAGE_TAGS.map(([attribute, key, content]) => {
      const node = document.createElement('meta');
      node.setAttribute(attribute, key);
      node.setAttribute('content', content);
      node.setAttribute(DEFAULT_IMAGE_TAG_MARKER, 'true');
      document.head.appendChild(node);
      return node;
    });
    return () => nodes.forEach((node) => node.remove());
  }, [active]);
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

  // The exported homepage and runtime share the same real public asset.
  const pageImage = image || `${WEB_BASE_URL.replace(/\/$/, '')}/og-image.jpg`;

  useDefaultImageTags(Platform.OS === 'web' && ready && !image);

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
