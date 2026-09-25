import React, { useCallback } from 'react';
import { Pressable } from 'react-native';
import { FlashList, type FlashListProps, type FlashListRef } from '@shopify/flash-list';
import Animated, { type AnimatedProps } from 'react-native-reanimated';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useFocusedScrollable } from '@/hooks/useFocusedScrollable';
import { useScrollPositionHandler } from '@/hooks/useScrollPositionHandler';
import PostItem from '@/components/Feed/PostItem';
import type {
  SavedPost,
  SavedPostsListProps,
} from './SavedPostsList.types';

/**
 * The list as a reanimated component, so its `onScroll` can be a worklet.
 * Built once at module scope: a new component type per render would remount it.
 */
const AnimatedFlashList = Animated.createAnimatedComponent(
  FlashList as React.ComponentType<FlashListProps<SavedPost>>,
) as React.ComponentType<
  AnimatedProps<FlashListProps<SavedPost>> & { ref?: React.Ref<FlashListRef<SavedPost>> }
>;

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
  const { scrollEventThrottle } = useLayoutScroll();
  const handleScroll = useScrollPositionHandler();
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
    <AnimatedFlashList
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
