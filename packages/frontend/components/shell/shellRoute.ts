import { createContext, createElement, useContext, useState, type ReactNode } from 'react';
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

const ShellRouteContext = createContext<ShellRoute>(shellRouteOf(null));

/** The current route's facts. Its value changes only when one of them does. */
export function useShellRoute(): ShellRoute {
  return useContext(ShellRouteContext);
}

/**
 * Publishes the route's facts for the shell. Mount it around the shell, inside
 * the router: it is the one place the path is read. It re-renders on every
 * navigation, its children do not; the shell re-renders when a fact changes,
 * in the navigation's own render, so a pushed post costs one render of the
 * tree, not a second one for the shell after the push has committed.
 */
export function ShellRouteProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [route, setRoute] = useState(() => shellRouteOf(pathname));
  const next = shellRouteOf(pathname);
  if (!sameRoute(route, next)) setRoute(next);
  return createElement(ShellRouteContext.Provider, { value: route }, children);
}
