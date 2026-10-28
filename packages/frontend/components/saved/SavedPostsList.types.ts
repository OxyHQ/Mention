import type { ReactElement } from 'react';
import type { HydratedPost } from '@mention/shared-types/post';

export type SavedPost = HydratedPost;

export interface SavedPostsListProps {
  /** Viewer, search and folder identity for web layout and scroll restoration. */
  restorationKey: string;
  posts: SavedPost[];
  empty: ReactElement | null;
  footer: ReactElement | null;
  hasNextPage: boolean;
  onEndReached: () => void;
  onLongPress: (postId: string) => void;
}
