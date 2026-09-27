import { useState } from 'react';
import { Platform } from 'react-native';
import { usePathname } from 'expo-router';
import { matchesServerSEOPath, profileSEOPolicy, readServerSEO } from '@/lib/seoHandoff';

/** Keep initial server privacy authoritative while appearance data is unresolved. */
export function useProfileSEOPolicy(visibility: 'public' | 'private' | 'followers_only' | undefined) {
  const pathname = usePathname();
  const [initialSEO] = useState(() => Platform.OS === 'web' && typeof document !== 'undefined'
    ? readServerSEO(document, window.location.pathname) : undefined);
  const server = initialSEO && matchesServerSEOPath(initialSEO, pathname) ? initialSEO : undefined;
  return profileSEOPolicy(visibility, server);
}
