import { useRouter } from 'expo-router';
import { useCallback } from 'react';

export function useSafeBack() {
  const router = useRouter();
  return useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/');
    }
  }, [router]);
}
