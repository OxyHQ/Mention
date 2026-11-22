import { useLayoutEffect } from 'react';
import { create } from 'zustand';
import { usePathname } from '@/lib/navigation/router';
import { hidesBottomBar } from './bottomBarRoutes';

/**
 * What the app shell reads from the route: the few facts its layout depends
 * on, never the path itself. The shell is the whole app's frame (the panels,
 * the sidebar, the bottom bar), so reading the path re-rendered all of it on
 * every navigation, a tab switch included, although none of these facts had
 * changed.
 */
export interface ShellRoute {
  /** Videos, whose panel is wider and whose replies sit beside the reel. */
  videos: boolean;
  /** The Deck route. */
  deck: boolean;
  /** An insights page, which takes the whole width. */
  insights: boolean;
  /** The full-bleed camera, which reserves no bar space on the web. */
  camera: boolean;
  /** A post's own page (`/p/<id>`), whose reply prompt replaces the bar. */
  post: boolean;
  /** A full-screen route, under no bar at all. */
  fullScreen: boolean;
}

const INSIGHTS = /^\/c\/[^/]+\/insights$/;
const POST = /^\/p\/[^/]+$/;

export function shellRouteOf(pathname: string | null | undefined): ShellRoute {
  const path = pathname ?? '';
  return {
    videos: path === '/videos',
    deck: path === '/deck',
    insights: path === '/insights' || path === '/insights/weekly_recap' || INSIGHTS.test(path),
    camera: path === '/camera',
    post: POST.test(path),
    fullScreen: hidesBottomBar(path),
  };
}

function sameRoute(a: ShellRoute, b: ShellRoute): boolean {
  return (
    a.videos === b.videos &&
    a.deck === b.deck &&
    a.insights === b.insights &&
    a.camera === b.camera &&
    a.post === b.post &&
    a.fullScreen === b.fullScreen
  );
}

/** The current route's facts. Its value changes only when one of them does. */
export const useShellRoute = create<ShellRoute>(() => shellRouteOf(null));

/**
 * Publishes the route's facts for the shell. Mount it beside the shell, inside
 * the router: it is the one place the path is read, and it renders nothing.
 * The facts land in a layout effect, so the shell's update is drawn in the
 * same frame as the navigation.
 */
export function ShellRouteSync() {
  const pathname = usePathname();
  useLayoutEffect(() => {
    const next = shellRouteOf(pathname);
    if (!sameRoute(useShellRoute.getState(), next)) useShellRoute.setState(next, true);
  }, [pathname]);
  return null;
}
