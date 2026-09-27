import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { INSTANCE_NAME } from '@/config';
import { releaseServerSEOForNavigation } from '@/lib/seoHandoff';

/** Routes without an SEO component must also retire the previous server page. */
export function SEOHandoff(): null {
  const pathname = usePathname();
  const [initialTitle] = useState(() => Platform.OS === 'web' && typeof document !== 'undefined'
    ? document.querySelector('title[data-mention-seo="true"]')?.textContent ?? undefined
    : undefined);
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      releaseServerSEOForNavigation(document, pathname, initialTitle, INSTANCE_NAME);
    }
  }, [pathname, initialTitle]);
  return null;
}
