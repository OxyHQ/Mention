/**
 * Federation types for ActivityPub/Mastodon integration
 */

export interface FederatedActorProfile {
  actorUri: string;
  handle: string;
  instance: string;
  fullHandle: string;
  displayName: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  isFollowing?: boolean;
  isFollowPending?: boolean;
}

export interface FederationSearchResult {
  actors: FederatedActorProfile[];
  query: string;
}

export interface FederationFollowResponse {
  success: boolean;
  pending: boolean;
  actorUri: string;
}

export interface FederationUnfollowResponse {
  success: boolean;
  actorUri: string;
}
