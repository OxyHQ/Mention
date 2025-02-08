export interface Profile {
  id: string;
  userID: string;
  name: {
    first?: string;
    last?: string;
  };
  avatar?: string;
  username?: string;
  bio?: string;
  location?: string;
  website?: string;
  joinDate?: string;
  description?: string;
  banner?: string;
  associated?: {
    lists: number;
    feedgens: number;
    starterPacks: number;
    labeler: boolean;
  };
  labels?: string[];
  created_at?: string;
  indexedAt?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  pinnedPost?: {
    cid: string;
    uri: string;
  };
  _count?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
}
