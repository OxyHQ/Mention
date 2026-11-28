import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';
import { createStore, useStore, type StoreApi } from 'zustand';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
import { Screen } from '@oxy.so/bloom/screen';
import { useRouter } from '@/lib/navigation/router';
import { WatchPlaybackVideo, type WatchPlaybackSource } from './WatchPlaybackVideo';
import type {
  WatchPlaybackProviderProps,
  WatchPlayerSurfaceProps,
  WatchVideoRailFrameProps,
} from './WatchPlayerSurface';

interface WatchSession extends WatchPlaybackSource {
  postId: string;
  mediaIndex: number;
  canContinue: boolean;
  surface: HTMLDivElement;
}

interface InlineTarget {
  node: HTMLDivElement;
  dockable: boolean;
}

interface WatchPlaybackState {
  session?: WatchSession;
  started?: boolean;
  inline?: InlineTarget;
  rail?: { postId?: string; node: HTMLDivElement };
}

const WatchPlaybackContext = createContext<StoreApi<WatchPlaybackState> | null>(null);

export function WatchPlaybackProvider({ children, pathname }: WatchPlaybackProviderProps) {
  const [playback] = useState(() => createStore<WatchPlaybackState>(() => ({})));
  return (
    <WatchPlaybackContext.Provider value={playback}>
      {children}
      <WatchPlaybackHost playback={playback} pathname={pathname} />
    </WatchPlaybackContext.Provider>
  );
}

export function WatchPlayerSurface({
  video,
  focused,
  dockable,
  concealed,
  canContinue,
  children,
}: WatchPlayerSurfaceProps) {
  const shared = useContext(WatchPlaybackContext);
  // A Deck column navigates on its own history, which the shared host never
  // sees: it would drop the session. The column draws its own player.
  const inColumn = Boolean(useOptionalPanelRouter());
  const playback = inColumn ? null : shared;
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const {
    post: { id: postId },
    mediaIndex,
    source,
    fallbackSource,
    poster,
  } = video;
  useLayoutEffect(() => {
    if (!playback || !node || !focused || concealed) return;
    const inline = { node, dockable };
    const { session, started } = playback.getState();
    const sameVideo = session?.postId === postId && session.mediaIndex === mediaIndex;
    const surface = sameVideo ? session.surface : node.ownerDocument.createElement('div');
    surface.className = 'h-full w-full';
    playback.setState({
      inline,
      session: { postId, mediaIndex, source, fallbackSource, poster, canContinue, surface },
      started: sameVideo && started,
    });
    return () => {
      if (playback.getState().inline === inline) playback.setState({ inline: undefined });
    };
  }, [
    playback,
    node,
    focused,
    concealed,
    dockable,
    postId,
    mediaIndex,
    source,
    fallbackSource,
    poster,
    canContinue,
  ]);

  return (
    <div
      ref={setNode}
      data-testid="watch-player-inline"
      className="flex aspect-video w-full flex-col items-center justify-center overflow-hidden rounded-2xl bg-black"
    >
      {concealed ? (
        children
      ) : !playback && (focused || !inColumn) ? (
        <WatchPlaybackVideo video={video} />
      ) : null}
    </div>
  );
}

function WatchPlaybackHost({
  playback,
  pathname,
}: Omit<WatchPlaybackProviderProps, 'children'> & { playback: StoreApi<WatchPlaybackState> }) {
  const { session, started, inline, rail } = useStore(playback);
  const watchDetail = pathname.startsWith('/watch/');
  const clips = pathname === '/videos';
  const canContinue = session?.canContinue && started;
  const browsing = Boolean(canContinue && !watchDetail && !clips);
  const discard = Boolean(
    session &&
      (watchDetail
        ? pathname !== `/watch/${encodeURIComponent(session.postId)}`
        : clips || !canContinue),
  );
  useLayoutEffect(() => {
    if (discard && playback.getState().session === session) {
      playback.setState({ session: undefined, started: false });
    }
  }, [discard, playback, session]);

  if (!session || discard) return null;
  return (
    <WatchPlaybackMount
      key={`${session.postId}:${session.mediaIndex}`}
      session={session}
      inline={watchDetail ? inline : undefined}
      rail={rail?.postId === (browsing ? undefined : session.postId) ? rail?.node : undefined}
      browsing={browsing}
      playback={playback}
    />
  );
}

function WatchPlaybackMount({
  session,
  inline,
  rail,
  browsing,
  playback,
}: {
  session: WatchSession;
  inline?: InlineTarget;
  rail?: HTMLDivElement;
  browsing: boolean;
  playback: StoreApi<WatchPlaybackState>;
}) {
  const { surface } = session;
  const router = useRouter();
  useLayoutEffect(() => () => surface.remove(), [surface]);

  useLayoutEffect(() => {
    if (browsing && rail) {
      rail.appendChild(surface);
      return;
    }
    const node = inline?.node;
    if (!node) {
      surface.remove();
      return;
    }
    node.appendChild(surface);
    if (!inline.dockable || !rail || typeof IntersectionObserver === 'undefined') return;

    // The sticky header occludes the bottom of the picture before it leaves the viewport.
    const header = node
      .closest('[data-testid="watch-video-screen"]')
      ?.querySelector('[data-testid="watch-video-screen-header"]');
    const edge = Math.max(0, Math.ceil(header?.getBoundingClientRect().bottom ?? 0));
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        const passedHeader = entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? edge);
        const target = passedHeader && rail.isConnected ? rail : node;
        // Move the stable portal container without unmounting its player or decoder.
        if (surface.parentElement !== target) target.appendChild(surface);
      },
      { rootMargin: `-${edge}px 0px 0px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inline, rail, surface, browsing]);

  useEffect(() => {
    if (!browsing) return;
    const dismissWhenAnotherVideoPlays = ({ target }: Event) => {
      if (
        target instanceof HTMLVideoElement &&
        !surface.contains(target) &&
        !(target.muted && target.loop)
      ) {
        playback.setState({ session: undefined, started: false });
      }
    };
    // Media events do not bubble. Capture also sees a player outside Watch's React subtree.
    document.addEventListener('playing', dismissWhenAnotherVideoPlays, true);
    return () => document.removeEventListener('playing', dismissWhenAnotherVideoPlays, true);
  }, [browsing, playback, surface]);

  useEffect(() => {
    if (!rail) return;
    const openFromPicture = (event: MouseEvent) => {
      const target = event.target;
      if (
        surface.parentElement !== rail ||
        event.button !== 0 ||
        !(target instanceof Element) ||
        target.closest('button, input, a, [role="button"], [role="slider"], [role="link"]')
      ) {
        return;
      }
      event.stopPropagation();
      if (browsing) {
        router.push({
          pathname: '/watch/[id]',
          params: { id: session.postId, mediaIndex: String(session.mediaIndex) },
        });
      } else {
        inline?.node.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    };
    // The controls share the player's tap layer. Leave their events with the original player.
    surface.addEventListener('click', openFromPicture, true);
    return () => surface.removeEventListener('click', openFromPicture, true);
  }, [browsing, inline, rail, router, session.mediaIndex, session.postId, surface]);

  return createPortal(
    <WatchPlaybackVideo
      video={session}
      onPlaybackStart={
        session.canContinue
          ? () => {
              if (!playback.getState().started) playback.setState({ started: true });
            }
          : undefined
      }
    />,
    surface,
  );
}

export function WatchBrowseRail({ children }: { children: ReactNode }) {
  const playback = useContext(WatchPlaybackContext);
  return playback ? <BrowseRail playback={playback}>{children}</BrowseRail> : children;
}

function BrowseRail({
  playback,
  children,
}: {
  playback: StoreApi<WatchPlaybackState>;
  children: ReactNode;
}) {
  const panel = useAppShellPanel();
  const session = useStore(playback, (state) => (state.started ? state.session : undefined));
  const showPlayer =
    session?.canContinue && panel.visibilityReady !== false && panel.active !== false;
  return (
    <Screen
      scroll={showPlayer ? 'auto' : 'none'}
      bottomBar={showPlayer ? <WatchDock /> : undefined}
    >
      {children}
    </Screen>
  );
}

function WatchDock({ postId }: { postId?: string }) {
  const playback = useContext(WatchPlaybackContext);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!playback || !node) return;
    const rail = { postId, node };
    playback.setState({ rail });
    return () => {
      if (playback.getState().rail === rail) playback.setState({ rail: undefined });
    };
  }, [playback, node, postId]);
  return (
    <div
      ref={setNode}
      data-testid={postId ? 'watch-player-dock' : 'watch-browse-player-dock'}
      className="mx-4 mb-3 aspect-video overflow-hidden rounded-xl bg-black empty:hidden"
    />
  );
}

export function WatchVideoRailFrame({ postId, children }: WatchVideoRailFrameProps) {
  return (
    <Screen scroll="auto" bottomBar={<WatchDock postId={postId} />} testID="watch-video-rail">
      <View className="px-4 pb-6 pt-3">{children}</View>
    </Screen>
  );
}
