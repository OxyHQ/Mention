import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useFocusedScrollable } from '@/hooks/useFocusedScrollable';
import PostItem from '@/components/Feed/PostItem';
import type {
  SavedPost,
  SavedPostsListProps,
} from './SavedPostsList.types';

const keyExtractor = (post: SavedPost) => post.id;
const getItemType = () => 'saved-post';

export default function SavedPostsList({
  posts,
  empty,
  footer,
  onEndReached,
  onLongPress,
}: SavedPostsListProps) {
  // The saved list is the page: it owns the shared scroll while Saved is in
  // front, so the chrome follows it and reselecting Saved can take it back up.
  const { handleScroll, scrollEventThrottle } = useLayoutScroll();
  const assignListRef = useFocusedScrollable<FlashListRef<SavedPost>>({ initialOffset: 0 });
  const renderItem = useCallback(
    ({ item }: { item: SavedPost }) => (
      <Pressable
        onLongPress={() => onLongPress(item.id)}
        delayLongPress={500}
      >
        <PostItem post={item} />
      </Pressable>
    ),
    [onLongPress],
  );

  return (
    <FlashList
      ref={assignListRef}
      onScroll={handleScroll}
      scrollEventThrottle={scrollEventThrottle}
      data={posts}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={renderItem}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      style={{ flex: 1 }}
      drawDistance={500}
    />
  );
}
