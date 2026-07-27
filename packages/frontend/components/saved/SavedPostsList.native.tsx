import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import PostItem from '@/components/Feed/PostItem';
import type {
  SavedPost,
  SavedPostsListProps,
} from './SavedPostsList.types';

const keyExtractor = (post: SavedPost) => post.id;
const getItemType = () => 'saved-post';

export default function SavedPostsList({
  posts,
  header,
  empty,
  footer,
  onEndReached,
  onLongPress,
  backgroundColor,
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
    <FlashList
      data={posts}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ backgroundColor }}
      style={{ flex: 1, backgroundColor }}
      drawDistance={500}
    />
  );
}
