import { useCallback } from 'react';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useReselect } from '@/context/ScreenReselectContext';
import { useRefSync } from '@/hooks/useRefSync';

/**
 * Whether `href` is the page the reader is on. Exact, not a prefix: the links
 * that ask are section roots (`/`, `/explore`, `/@handle`), and from a page
 * below one of them (`/@handle/replies`) the link still means "go there".
 */
export function isCurrentRoute(href: Href, pathname: string): boolean {
    return typeof href === 'string' && href === pathname;
}

/**
 * The one way a navigation control goes somewhere: to `href`, or — when it is
 * already the current page — back to the top of it, then a reload.
 */
export function useNavigateOrReselect(): (href: Href) => void {
    const router = useRouter();
    // Read at press time, so the callback keeps one identity across navigations
    // and the memoized navigation descriptors built from it survive them.
    const pathnameRef = useRefSync(usePathname());
    const reselect = useReselect();
    return useCallback((href: Href) => {
        if (isCurrentRoute(href, pathnameRef.current)) reselect();
        else router.navigate(href);
    }, [pathnameRef, reselect, router]);
}
