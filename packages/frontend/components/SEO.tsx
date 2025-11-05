import React from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';

// Only import Head on web to avoid native errors
let Head: any = null;
if (Platform.OS === 'web') {
  try {
    // Try multiple import methods for compatibility
    const expoRouterHead = require('expo-router/head');
    Head = expoRouterHead.Head || expoRouterHead.default || expoRouterHead;
  } catch (e) {
    // Head not available - will return null component
    console.warn('SEO: expo-router/head not available', e);
  }
}

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
}

const defaultSEO = {
  siteName: 'Mention',
  twitterHandle: '@mention',
  type: 'website' as const,
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

  // Default image (you should add your logo/image)
  const pageImage = image || 'https://mention.earth/og-image.png';

  // Only render on web
  if (Platform.OS !== 'web' || !Head) {
    return null;
  }

  return (
    <Head>
      {/* Primary Meta Tags */}
      <title>{pageTitle}</title>
      <meta name="title" content={pageTitle} />
      <meta name="description" content={pageDescription} />
      
      {/* Open Graph / Facebook */}
      <meta property="og:type" content={type} />
      <meta property="og:url" content={fullUrl} />
      <meta property="og:title" content={pageTitle} />
      <meta property="og:description" content={pageDescription} />
      <meta property="og:image" content={pageImage} />
      <meta property="og:site_name" content={siteName} />
      
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
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <link rel="canonical" href={fullUrl} />
    </Head>
  );
};

export default SEO;

