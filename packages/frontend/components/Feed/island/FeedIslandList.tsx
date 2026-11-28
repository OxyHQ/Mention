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
 */
import { useCallback, useMemo } from 'react';
import {
  requireNativeComponent,
  StyleSheet,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';
import { useBloomTheme, useTheme } from '@oxy.so/bloom/theme';
import { benchMark } from '@/lib/bench';
import { usePostInteractions } from '../postInteractions';
import type { FeedRow } from '../feedRows';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { feedIslandPostById, feedIslandPosts, type FeedIslandIntent } from './feedIslandData';

interface IslandEvent {
  name: string;
  payload: string;
}

interface NativeIslandProps extends ViewProps {
  island: string;
  props: string;
  themePreset?: string;
  themeScheme?: string;
  onIslandEvent?: (event: NativeSyntheticEvent<IslandEvent>) => void;
}

const BloomIsland = requireNativeComponent<NativeIslandProps>('BloomIsland');

const BENCH = process.env.EXPO_PUBLIC_BLOOM_BENCH === '1';
/** The intents that write to the account. */
const WRITES = new Set(['like', 'repost', 'save', 'reply', 'send']);

interface Router {
  push: (href: never) => void;
}

export interface FeedIslandListProps {
  rows: readonly FeedRow[];
  router: unknown;
  feedDescriptor?: string;
  onLoadMore: () => void;
  topInset: number;
  bottomInset: number;
}

export function FeedIslandList({
  rows,
  router,
  feedDescriptor,
  onLoadMore,
  topInset,
  bottomInset,
}: FeedIslandListProps) {
  const interactions = usePostInteractions();
  const { colorPreset } = useBloomTheme();
  const theme = useTheme();
  const json = useMemo(() => {
    const posts = feedIslandPosts(rows);
    // Bench: the first time the feed hands the island posts.
    if (posts.length > 0) benchMark('island-props');
    return JSON.stringify({ posts, topInset, bottomInset });
  }, [rows, topInset, bottomInset]);

  const onIslandEvent = useCallback(
    (event: NativeSyntheticEvent<IslandEvent>) => {
      const { name, payload } = event.nativeEvent;
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
      const post = feedIslandPostById(rows, intent.postId);
      if (!post) return;
      // A bench build (EXPO_PUBLIC_BLOOM_BENCH=1) runs on a real, signed-in account: it only views
      // and scrolls. Every write (like, repost, save, reply, send) is dropped and logged.
      if (BENCH && WRITES.has(intent.kind)) {
        console.log(`BLOOM_BENCH dropped-write ${intent.kind} ${post.id}`);
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
    },
    [rows, router, feedDescriptor, onLoadMore, interactions],
  );

  return (
    <BloomIsland
      island="FeedIsland"
      props={json}
      themePreset={colorPreset}
      themeScheme={theme.isDark ? 'dark' : 'light'}
      onIslandEvent={onIslandEvent}
      style={styles.island}
    />
  );
}

const styles = StyleSheet.create({
  island: { flex: 1 },
});
