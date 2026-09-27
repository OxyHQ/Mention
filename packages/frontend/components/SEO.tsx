import React, { useCallback } from 'react';
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
      {!image && <meta property="og:image:width" content="1280" />}
      {!image && <meta property="og:image:height" content="720" />}
      {!image && <meta property="og:image:type" content="image/jpeg" />}
      {!image && <meta property="og:image:alt" content={defaultSEO.imageAlt} />}
      <meta property="og:site_name" content={finalSiteName} />
      
      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={fullUrl} />
      <meta name="twitter:title" content={pageTitle} />
      <meta name="twitter:description" content={pageDescription} />
      <meta name="twitter:image" content={pageImage} />
      {!image && <meta name="twitter:image:alt" content={defaultSEO.imageAlt} />}
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
