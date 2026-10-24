import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { VirtualList } from '@oxy.so/bloom/list';
import { Pressable } from 'react-native';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import PostItem from '@/components/Feed/PostItem';
import type { SavedPost, SavedPostsListProps } from './SavedPostsList.types';

const ESTIMATED_POST_HEIGHT = 280;
const OVERSCAN_POSTS = 6;

const keyExtractor = (post: SavedPost) => post.id;

/**
 * Saved posts participate in Mention's document-scroll shell on web: Bloom's
 * `VirtualList` windows the rows against the Screen's scroller and introduces
 * no nested overflow container.
 */
export default function SavedPostsList({
  posts,
  empty,
  footer,
  hasNextPage,
  onEndReached,
  onLongPress,
}: SavedPostsListProps) {
  const panel = usePanelScrollContainer<HTMLElement>();
  useScrollRestoration('window', { enabled: !panel });

  return (
    <VirtualList
      data={posts}
      keyExtractor={keyExtractor}
      renderItem={({ item }) => (
        <Pressable onLongPress={() => onLongPress(item.id)} delayLongPress={500}>
          <PostItem post={item} />
        </Pressable>
      )}
      estimatedItemSize={ESTIMATED_POST_HEIGHT}
      overscan={OVERSCAN_POSTS}
      onEndReached={hasNextPage ? onEndReached : undefined}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
    />
  );
}
