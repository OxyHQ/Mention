import type { ChannelWritersResponse } from '@mention/shared-types';
import { authenticatedClient } from '@/utils/api';

const CHANNELS_PATH = '/channels';

/**
 * A channel's writers — the people it has already named on its posts.
 *
 * The list is who HAS WRITTEN, never who MAY write. The server derives it from
 * the channel's public, published posts, so every name it returns is one the
 * channel is already publishing on a post any reader can open. It is NOT the
 * account's member roll, which would name people who have written nothing and
 * consented to nothing.
 *
 * `authenticatedClient` rather than `publicApi`, even though a channel's page is
 * public: the endpoint is `optionalAuth`, and the reader's identity is what lets
 * a follower of a RESTRICTED channel see the list at all. The linked client
 * simply sends the request unauthenticated when there is no session, which is
 * the anonymous case — so one client covers both readers, while `publicApi`
 * would silently hide the tab from a signed-in follower.
 *
 * NOTHING HERE CATCHES, and that is the whole contract with the caller. A 404 is
 * this endpoint's answer for "there is no list here" — not a channel, a channel
 * that does not name its writers, a channel this reader may not see — and the
 * tab's existence is keyed on it. Swallowing it into an empty list would turn
 * every one of those into a channel that discloses and has published nothing,
 * which is a different fact and the one case that DOES render a tab.
 */
class ChannelWritersService {
  /**
   * One page of a channel's writers, most recent publication first.
   *
   * `cursor` is the opaque `nextCursor` from the previous page; its absence in
   * the response is the end of the list. `limit` is left to the server's own
   * default rather than restated here — a second copy of a page size is a second
   * thing to keep in step.
   */
  async list(channelOxyUserId: string, cursor?: string): Promise<ChannelWritersResponse> {
    const params: { cursor?: string } = {};
    if (cursor) params.cursor = cursor;

    const res = await authenticatedClient.get<ChannelWritersResponse>(
      `${CHANNELS_PATH}/${encodeURIComponent(channelOxyUserId)}/writers`,
      { params },
    );
    return res.data;
  }
}

export const channelWritersService = new ChannelWritersService();
