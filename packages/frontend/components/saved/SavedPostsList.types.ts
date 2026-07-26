import type { ReactElement } from 'react';
import type { HydratedPost } from '@mention/shared-types/post';

export type SavedPost = HydratedPost;

export interface SavedPostsListProps {
  posts: SavedPost[];
  header: ReactElement | null;
  empty: ReactElement | null;
  footer: ReactElement | null;
  hasNextPage: boolean;
  onEndReached: () => void;
  onLongPress: (postId: string) => void;
  backgroundColor: string;
}
