import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { usePathname } from '@/lib/navigation/router';
import { INSTANCE_NAME } from '@/config';
import { initialSEODocumentPath, releaseServerSEOForNavigation, samePath } from '@/lib/seoHandoff';
import { armPrerenderRelease, releasePrerender } from '@/lib/prerender';

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
      // The server's first frame describes the document's own path only.
      if (!samePath(initialSEODocumentPath(document), pathname)) releasePrerender();
    }
  }, [pathname, initialTitle]);
  // However the route fares, the first frame never outlives the app's boot.
  useEffect(() => (Platform.OS === 'web' ? armPrerenderRelease() : undefined), []);
  return null;
}
