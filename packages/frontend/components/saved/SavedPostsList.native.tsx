// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { VirtualList } from '@oxy.so/bloom/list';
import PostItem from '@/components/Feed/PostItem';
import { useOpenPostEngagement } from '@/components/Post/postEngagementContext';
import type { SavedPost, SavedPostsListProps } from './SavedPostsList.types';

const keyExtractor = (post: SavedPost) => post.id;
const getItemType = () => 'saved-post';

export default function SavedPostsList({
  posts,
  empty,
  footer,
  onEndReached,
  onLongPress,
}: SavedPostsListProps) {
  const openPostEngagement = useOpenPostEngagement();
  const renderItem = useCallback(
    ({ item }: { item: SavedPost }) => (
      <Pressable onLongPress={() => onLongPress(item.id)} delayLongPress={500}>
        <PostItem post={item} openPostEngagement={openPostEngagement} />
      </Pressable>
    ),
    [onLongPress, openPostEngagement],
  );

  return (
    // The saved list is the page: it owns the shared scroll while Saved is in
    // front, so the chrome follows it and reselecting Saved takes it back up.
    <VirtualList
      screen={{}}
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
      scrollbar="never"
      style={{ flex: 1 }}
      drawDistance={500}
    />
  );
}
