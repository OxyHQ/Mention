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
import type { ChannelRow } from '../db/channels/channelRepository';

/**
 * Serialize one channel row.
 *
 * Every optional DTO field is OMITTED rather than sent as `null`: Postgres hands
 * back `null` for an unset `text` column where Mongo simply left the key out,
 * and `Channel.description` is `string | undefined`. Emitting the `null` would
 * typecheck nowhere and render as the string "null" in any client that trusts
 * truthiness less than the type.
 *
 * `visibility` is the STORED value rather than a literal. `ChannelVisibility`
 * has one member today, so the column's type is that one member and this reads
 * as a constant — but it is the row that decides, so a second level added to the
 * enum reaches the wire without anyone having to remember this line exists.
 */
export function serializeChannel(
  row: ChannelRow,
  viewerState?: ChannelViewerState,
): ChannelDTO {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.avatar ? { avatar: row.avatar } : {}),
    ...(row.banner ? { banner: row.banner } : {}),
    ownerOxyUserId: row.ownerOxyUserId,
    visibility: row.visibility,
    signPosts: row.signPosts,
    followerCount: row.followerCount,
    memberCount: row.memberCount,
    postCount: row.postCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(viewerState ? { viewerState } : {}),
  };
}
