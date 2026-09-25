import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { FocusedFlashList } from '@/components/common/FocusedFlashList';
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
    // The saved list is the page: it owns the shared scroll while Saved is in
    // front, so the chrome follows it and reselecting Saved takes it back up.
    <FocusedFlashList
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
