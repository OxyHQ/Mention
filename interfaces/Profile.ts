export interface Profile {
  _id: string;
  userID: string;
  username: string;
  name?: {
    first?: string;
    last?: string;
  };
  avatar?: string;
  associated?: {
    lists?: number;
    feedgens?: number;
    starterPacks?: number;
    labeler?: boolean;
  };
  labels?: string[];
  created_at?: string;
  description?: string;
  indexedAt?: string;
  banner?: string;
  location?: string;
  website?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  pinnedPost?: {
    cid?: string;
    uri?: string;
  };
  _count?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
  joinDate?: string;
}
