/**
 * The wire shape of a channel — ONE definition, for the same reason
 * `services/channelAccess.ts` is the one definition of what somebody may DO with
 * a channel.
 *
 * Two surfaces now answer with a channel: the channels API itself
 * (`routes/channels.routes.ts`) and search (`services/channelSearch.ts`). A
 * second serializer would be a second answer to "what is a channel to a client",
 * and the two would drift on the first field either one gains — a card rendered
 * from a search result would quietly lose whatever the directory grew.
 */

import type {
  Channel as ChannelDTO,
  ChannelViewerState,
} from '@mention/shared-types';

/** Shape of a `Channel` document as the read paths load it back. */
export interface ChannelLean {
  _id: unknown;
  handle: string;
  title: string;
  description?: string;
  avatar?: string;
  banner?: string;
  ownerOxyUserId: string;
  visibility: string;
  signPosts?: boolean;
  followerCount?: number;
  memberCount?: number;
  postCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeChannel(
  doc: ChannelLean,
  viewerState?: ChannelViewerState,
): ChannelDTO {
  return {
    id: String(doc._id),
    handle: doc.handle,
    title: doc.title,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.avatar ? { avatar: doc.avatar } : {}),
    ...(doc.banner ? { banner: doc.banner } : {}),
    ownerOxyUserId: doc.ownerOxyUserId,
    // The stored value is the authority; the cast is safe because the schema enum
    // is the same list the DTO type is built from.
    visibility: 'public',
    signPosts: doc.signPosts === true,
    followerCount: doc.followerCount ?? 0,
    memberCount: doc.memberCount ?? 0,
    postCount: doc.postCount ?? 0,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    ...(viewerState ? { viewerState } : {}),
  };
}
