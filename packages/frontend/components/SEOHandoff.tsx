import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { INSTANCE_NAME } from '@/config';
import { initialSEODocumentPath, releaseServerSEOForNavigation } from '@/lib/seoHandoff';

/** Routes without an SEO component must also retire the previous server page. */
export function SEOHandoff(): null {
  const pathname = usePathname();
  const [initialTitle] = useState(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return undefined;
    initialSEODocumentPath(document);
    return document.querySelector('title[data-mention-seo="true"]')?.textContent ?? undefined;
  });
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      releaseServerSEOForNavigation(document, pathname, initialTitle, INSTANCE_NAME);
    }
  }, [pathname, initialTitle]);
  return null;
}
