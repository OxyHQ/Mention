/**
 * The feed drawn by the `FeedIsland` Compose island (Bloom ADR 0003, M1), in place of the
 * FlashList, when the bundle is built with `EXPO_PUBLIC_BLOOM_ISLAND_FEED=1`. React Native keeps
 * the feed's data, its stores and its writes: this hands the island the rows' posts as JSON and
 * carries out each intent the island sends (`onIntent`) through the same interactions and routes
 * a `PostItem` row uses. The island itself is pure Bloom (`Sources/FeedIsland`), compiled to
 * Kotlin and Compose by `bloom build android`'s native backend.
 *
 * The host is React Native's `BloomIsland` view (registered by the build's `:bloom-islands`
 * library), named here directly: Mention's `.bloom` files are on the 1.x language, whose
 * pipeline has no `extern native`, so the standard library's `Island` is not reachable yet.
 *
 * The island is keyed (`islandKey`, one per feed): its posts reach it through the
 * `BloomIslands` module (`setProps(key, json)`) as soon as this list renders them, not with
 * React's commit, and its intents come back as `BloomIslandEvent`s. The home feed's island is
 * mounted at the root before any data (`FeedIslandRoot`, out of sight): it composes the posts
 * there, and the home screen's host draws that composition at once when it mounts.
 */
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { Embed, Menu, toElement } from '@oxy.so/bloom-language';
import { describePostMenu, PostMenuActions } from '../PostMenu';
import {
  DeviceEventEmitter,
  requireNativeComponent,
  StyleSheet,
  View,
  TurboModuleRegistry,
  type TurboModule,
  type ViewInstance,
  type ViewProps,
} from 'react-native';
import { useBloomTheme, useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import { resolveAvatarTint, type AvatarColor } from '@oxy.so/bloom/avatar';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { benchMark } from '@/lib/bench';
import type { HydratedPost } from '@mention/shared-types';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import type { FeedProps } from '../useFeedCore';
import { usePostInteractions } from '../postInteractions';
import type { FeedRow } from '../feedRows';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { openExternalLink } from '@/utils/openExternalLink';
import {
  feedIslandAvatar,
  feedIslandPostById,
  feedIslandPosts,
  type FeedIslandIntent,
} from './feedIslandData';

interface IslandEvent {
  key: string;
  name: string;
  payload: string;
  /** The view the intent was pressed on, in the window's points (Bloom #1080). */
  anchor?: IslandAnchor;
}

interface IslandAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeIslandProps extends ViewProps {
  island: string;
  islandKey?: string;
  props?: string;
  themePreset?: string;
  themeScheme?: string;
  /** The theme's resolved colours (`useColorTokens()`), as JSON: they win over the preset's. */
  themeColors?: string;
}

const BloomIsland = requireNativeComponent<NativeIslandProps>('BloomIsland');

/** `:bloom-islands`' keyed channel: a keyed island's data, set off React's commit. */
interface BloomIslandsModule extends TurboModule {
  setProps(key: string, json: string): void;
  setTheme(key: string, preset: string | null, scheme: string | null, colors: string | null): void;
}

const islands = TurboModuleRegistry.get<BloomIslandsModule>('BloomIslands');

const AVATAR_TINTS: readonly AvatarColor[] = ['blue', 'lime', 'pink', 'neutral'];

/** The avatar discs' tints in `theme` (`avatarBlue`, `avatarBlueForeground`, …), which the island's theme has no token for. */
function avatarTints(theme: Parameters<typeof resolveAvatarTint>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const color of AVATAR_TINTS) {
    const tint = resolveAvatarTint(theme, color);
    const name = `avatar${color[0]?.toUpperCase()}${color.slice(1)}`;
    out[name] = tint.background;
    out[`${name}Foreground`] = tint.foreground;
  }
  return out;
}

/** A user's name as Bloom's avatar reads it (`accountName`): the display name, else the handle. */
function accountName(user: { name?: unknown; username?: string } | undefined): string | undefined {
  const name = user?.name as
    | string
    | { displayName?: string; full?: string; first?: string; last?: string }
    | undefined;
  const text =
    typeof name === 'string'
      ? name
      : name?.displayName?.trim() ||
        name?.full?.trim() ||
        [name?.first, name?.last].filter(Boolean).join(' ');
  return text?.trim() || user?.username?.trim() || undefined;
}

/**
 * A post's ⋯ menu for a row of the island: the row's own menu (`describePostMenu`,
 * `PostMenuActions`), presented from a trigger laid over the glyph pressed in the island, and open
 * from the start (`.presented`); closed, it unmounts.
 */
function IslandPostMenu({
  host,
  post,
  anchor,
  source,
  label,
  onClosed,
}: {
  host: RefObject<ViewInstance | null>;
  post: HydratedPost;
  anchor: IslandAnchor;
  source: string | undefined;
  label: string;
  onClosed: () => void;
}) {
  const services = usePostInteractions().menuServices();
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    host.current?.measureInWindow((x, y) => setOrigin({ x, y }));
  }, [host]);
  if (!services || !origin) return null;
  const props = {
    post,
    isPostDetail: false,
    source,
    onOpenArticle: () => {},
    onInsights: () => {},
  };
  const rows = describePostMenu(props, services);
  const place = {
    position: 'absolute' as const,
    left: anchor.x - origin.x,
    top: anchor.y - origin.y,
    width: anchor.width,
    height: anchor.height,
  };
  return (
    <View style={place} pointerEvents="box-none">
      {toElement(
        Menu(Embed(<View style={{ width: anchor.width, height: anchor.height }} />), ...rows)
          .actions(PostMenuActions(props))
          .presented([true, (open: boolean) => (open ? undefined : onClosed())])
          .label(label),
      )}
    </View>
  );
}

/** The island of the feed `descriptor` (the home's first tab is `for_you`). */
export function feedIslandKey(descriptor: string | undefined): string {
  return `feed:${descriptor ?? 'feed'}`;
}

const BENCH = process.env.EXPO_PUBLIC_BLOOM_BENCH === '1';
/** How many rows the first props carry: more than a screen of the shortest rows. */
const FIRST_SCREEN = 6;

/**
 * The home feed's island, mounted at the root as the app starts, before the feed has data, the
 * size of the screen and out of sight: Compose and the island are up early, the posts compose
 * here the moment `FeedIslandList` hands them to the module, and the home screen's host (the
 * same key) then draws this composition at once. Mounted with `EXPO_PUBLIC_BLOOM_ISLAND_FEED=1`.
 */
export function FeedIslandRoot() {
  return (
    <BloomIsland
      island="FeedIsland"
      islandKey={feedIslandKey('for_you')}
      pointerEvents="none"
      style={styles.root}
    />
  );
}
/** The intents that write to the account. */
const WRITES = new Set(['like', 'repost', 'save', 'reply', 'send']);

interface Router {
  push: (href: never) => void;
}

export interface FeedIslandListProps {
  rows: readonly FeedRow[];
  /** The screen's feed tabs (Home's), drawn by the island above its first row. */
  tabs?: FeedProps['islandTabs'];
  /** The compose prompt above the first row (signed in only), and what it opens. */
  composer?: boolean;
  onComposePress?: () => void;
  router: unknown;
  feedDescriptor?: string;
  onLoadMore: () => void;
  topInset: number;
  bottomInset: number;
}

export function FeedIslandList({
  rows,
  tabs,
  composer,
  onComposePress,
  router,
  feedDescriptor,
  onLoadMore,
  topInset,
  bottomInset,
}: FeedIslandListProps) {
  const interactions = usePostInteractions();
  // The ⋯ menu a row of the island asked for, and the glyph it grows out of.
  const [menu, setMenu] = useState<{ post: HydratedPost; anchor: IslandAnchor } | null>(null);
  const hostRef = useRef<ViewInstance>(null);
  const { colorPreset } = useBloomTheme();
  const theme = useTheme();
  // The island draws in this screen's theme as React Native resolved it (its accents, seed or
  // ambient colour), not only in its preset's colours.
  const tokens = useColorTokens();
  // `backing`: the surface this list sits on, what a lens in the island samples (the page's card).
  const backing = useSurfaceFill();
  const colors = useMemo(
    () => JSON.stringify({ ...tokens, ...avatarTints(theme), backing }),
    [tokens, theme, backing],
  );
  const posts = useMemo(() => feedIslandPosts(rows), [rows]);
  const { user } = useAuth();
  const { t } = useTranslation();
  // The rows above the first post, as Feed's own list draws them: the tabs, then the composer.
  const header = useMemo(
    () => ({
      tabs: tabs?.tabs ?? [],
      active: tabs?.active ?? '',
      composer: composer === true && user != null,
      avatar: feedIslandAvatar(user?.avatar),
      name: accountName(user ?? undefined) ?? '',
      prompt: t('compose.placeholder'),
    }),
    [tabs?.tabs, tabs?.active, composer, user, t],
  );
  // The first screen's rows go first, alone: the island decodes and draws them while the rest of
  // the page follows a frame later.
  const [streamed, setStreamed] = useState(false);
  const firstScreen = !streamed && posts.length > FIRST_SCREEN;
  useEffect(() => {
    if (!firstScreen) return;
    const frame = requestAnimationFrame(() => setStreamed(true));
    return () => cancelAnimationFrame(frame);
  }, [firstScreen]);
  const key = feedIslandKey(feedDescriptor);
  const scheme = theme.isDark ? 'dark' : 'light';
  // The theme and the posts go to the island from this render, not the commit after it.
  useMemo(
    () => islands?.setTheme(key, colorPreset ?? null, scheme, colors),
    [key, colorPreset, scheme, colors],
  );
  const json = useMemo(() => {
    const shown = firstScreen ? posts.slice(0, FIRST_SCREEN) : posts;
    const text = JSON.stringify({ posts: shown, topInset, bottomInset, header });
    if (shown.length > 0) {
      // Bench: the first time the feed hands the island posts.
      benchMark('island-props');
      islands?.setProps(key, text);
    }
    return text;
  }, [key, posts, firstScreen, topInset, bottomInset, header]);

  // The island's intents, read through a ref: the listener is added once per key.
  const onEvent = useRef<(event: IslandEvent) => void>(() => {});
  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener(
      'BloomIslandEvent',
      (event: IslandEvent) => {
        if (event.key === key) onEvent.current(event);
      },
    );
    return () => subscription.remove();
  }, [key]);

  onEvent.current = (event: IslandEvent) => {
    const { name, payload, anchor } = event;
    if (name !== 'onIntent') return;
    let intent: FeedIslandIntent;
    try {
      intent = JSON.parse(payload) as FeedIslandIntent;
    } catch {
      return;
    }
    if (intent.kind === 'more') {
      onLoadMore();
      return;
    }
    // A link in a body or a card: a route of the app, or an address opened outside it.
    // The rows above the posts: a tab, the composer and its camera.
    if (intent.kind === 'tab') {
      tabs?.onSelect(intent.href);
      return;
    }
    if (intent.kind === 'compose') {
      if (onComposePress) onComposePress();
      else (router as Router).push('/compose' as never);
      return;
    }
    if (intent.kind === 'camera') {
      (router as Router).push('/camera' as never);
      return;
    }
    if (intent.kind === 'link') {
      if (intent.href.startsWith('/')) (router as Router).push(intent.href as never);
      else if (intent.href) openExternalLink(intent.href);
      return;
    }
    const post = feedIslandPostById(rows, intent.postId);
    if (!post) return;
    // A bench build (EXPO_PUBLIC_BLOOM_BENCH=1) runs on a real, signed-in account: it only views
    // and scrolls. Every write (like, repost, save, reply, send) is dropped and logged.
    if (BENCH && WRITES.has(intent.kind)) {
      console.log(`BLOOM_BENCH dropped-write ${intent.kind} ${post.id}`);
      return;
    }
    if (intent.kind === 'menu') {
      // The post's ⋯ menu, presented as the row's own is (the lens menu), growing out of the
      // glyph that was pressed in the island.
      if (anchor) setMenu({ post, anchor });
      return;
    }
    const go = (href: string | null | undefined) => {
      if (href) (router as Router).push(href as never);
    };
    switch (intent.kind) {
      case 'like':
        if (interactions.requireSession()) void interactions.toggleLike(post, feedDescriptor);
        break;
      case 'repost':
        if (interactions.requireSession()) void interactions.toggleBoost(post, feedDescriptor);
        break;
      case 'save':
        if (interactions.requireSession()) void interactions.toggleSave(post, feedDescriptor);
        break;
      case 'share':
        interactions.share(post);
        break;
      case 'send':
        interactions.sendInAllo(post.id);
        break;
      case 'reply':
        if (interactions.requireSession()) go(`/compose?replyToPostId=${post.id}`);
        break;
      case 'profile':
        interactions.prefetchProfile(post.user?.id);
        go(profileHrefForUser(post.user) as string | null);
        break;
      case 'open':
      case 'quote':
      case 'media':
        go(`/p/${post.id}`);
        break;
      default:
        break;
    }
  };

  // Without the module (an older build), the host takes the posts as a prop.
  return (
    <View ref={hostRef} style={styles.island} collapsable={false}>
      <BloomIsland
        island="FeedIsland"
        islandKey={key}
        props={islands ? undefined : json}
        themePreset={colorPreset}
        themeScheme={scheme}
        themeColors={colors}
        style={styles.island}
      />
      {menu ? (
        <IslandPostMenu
          host={hostRef}
          post={menu.post}
          anchor={menu.anchor}
          source={feedDescriptor}
          label={t('postActions.title', { defaultValue: 'Post options' })}
          onClosed={() => setMenu(null)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  island: { flex: 1 },
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 },
});
