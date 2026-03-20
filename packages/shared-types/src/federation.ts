/**
 * Federation types for ActivityPub/Mastodon integration
 */

export interface FederatedActorField {
  name: string;
  value: string;
  verifiedAt?: string;
}

export interface FederatedActorProfile {
  actorUri: string;
  handle: string;
  instance: string;
  fullHandle: string;
  displayName: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bio?: string;
  fields?: FederatedActorField[];
  followersCount?: number;
  followingCount?: number;
  postsCount?: number;
  isFollowing?: boolean;
  isFollowPending?: boolean;
  discoverable?: boolean;
  memorial?: boolean;
  suspended?: boolean;
  createdAt?: string;
  type?: string;
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
