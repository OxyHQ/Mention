/**
 * Communities hosted on Mention — the moderation surface.
 *
 * A community is an Oxy ACCOUNT (`kind: 'community'`) whose members are its
 * moderators; Mention stores neither the community nor its moderators. What it
 * does store is what moderators decide: who is banned from posting in it. A post
 * a moderator removes simply stops being written in the community (its
 * `community` is cleared); it remains its author's.
 */

import type { PostUser } from './post';

/**
 * Communities are in a private preview: only these accounts see or use them.
 * One list for the app (what to show) and the server (what to answer), so the
 * two cannot disagree about who is in. Compared lower-cased, without spacing.
 */
export const COMMUNITY_PREVIEW_HANDLES: readonly string[] = ['oxy', 'nate'];

/** Whether the account with this handle is in the communities preview. */
export function canUseCommunities(username: string | null | undefined): boolean {
  const handle = username?.trim().toLowerCase();
  return !!handle && COMMUNITY_PREVIEW_HANDLES.includes(handle);
}

/** Longest reason a moderator may give for a removal or a ban. */
export const COMMUNITY_MODERATION_REASON_MAX_LENGTH = 300;

/** Longest title a community post may carry (Lemmy's own cap). */
export const COMMUNITY_POST_TITLE_MAX_LENGTH = 200;

/** One person banned from a community. */
export interface CommunityBan {
  /** The banned account, the canonical Oxy {@link PostUser} passed through unchanged. */
  user: PostUser;
  reason: string | null;
  /** When the ban was made, ISO 8601. */
  createdAt: string;
}

/** `GET /communities/joined` — the communities hosted here the caller has joined. */
export interface JoinedCommunitiesResponse {
  communities: PostUser[];
}

/** `GET /communities/:id/bans`. */
export interface CommunityBansResponse {
  bans: CommunityBan[];
}

/** Body of `POST /communities/:id/bans` and of a post removal. */
export interface CommunityModerationRequest {
  reason?: string;
}

/** Body of `POST /communities/:id/bans`. */
export interface CommunityBanRequest extends CommunityModerationRequest {
  userId: string;
}
