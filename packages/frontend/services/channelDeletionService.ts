import type { ChannelDeletionCounts } from '@mention/shared-types';
import { authenticatedClient } from '@/utils/api';

const CHANNELS_PATH = '/channels';

/**
 * MENTION'S HALF of deleting a channel: its posts, and every Mention row that
 * points at them.
 *
 * The OTHER half — archiving the account itself — is Oxy's, and is performed by
 * the caller with `oxyServices.archiveAccount`. It is deliberately not wrapped
 * here: this module would then read as "delete a channel" while owning neither
 * the account nor the order the two halves have to run in, and the one thing a
 * caller must get right is that order.
 *
 * ## The order, and why it is this way round
 *
 * Mention first, and only on SUCCESS may the account be archived. Oxy's account
 * reads exclude an archived account (`GET /users/:id` answers 404, and
 * `POST /users/by-ids` filters them out), and Mention's cascade resolves the
 * account's kind and its username through exactly those reads: it refuses to
 * delete an account whose kind it cannot establish, and it cannot address a
 * `Delete(Tombstone)` for a post whose canonical id is minted from a username it
 * can no longer resolve. Archive first and the posts are stranded permanently,
 * with nothing left that can re-target them.
 *
 * The failure between the halves is therefore the survivable one: the posts are
 * gone, the fediverse has been told, and the account still stands. The operator
 * retries, the cascade converges (a second run over an emptied channel reports
 * zero and does not throw), and the archive lands.
 *
 * Nothing here catches. A deletion that failed must say so — one that quietly
 * reported success would send the caller on to archive the account, which is the
 * one step that makes the failure permanent.
 */
class ChannelDeletionService {
  /**
   * What deleting this channel would destroy, counted. Reads only.
   *
   * Fetched when the operator asks to delete, never on mount: it walks the
   * channel's whole publishing history plus the boost closure over it, and its
   * only consumer is the confirmation, which does not exist until then.
   *
   * Behind the SAME `account:delete` gate as the deletion itself, so a preview
   * that answers is a deletion that will be permitted.
   */
  async preview(oxyUserId: string): Promise<ChannelDeletionCounts> {
    const res = await authenticatedClient.get<ChannelDeletionCounts>(
      `${CHANNELS_PATH}/${encodeURIComponent(oxyUserId)}/deletion-preview`,
    );
    return res.data;
  }

  /**
   * Destroy the channel's posts and every Mention row pointing at them, and tell
   * every server that received a copy to remove it.
   *
   * Resolves with what was destroyed. It rejects rather than reporting a partial
   * result: the server runs every remaining step after one fails and throws at
   * the end, so a rejection means some of the channel survived and the account
   * must NOT be archived yet.
   */
  async deleteContent(oxyUserId: string): Promise<ChannelDeletionCounts> {
    const res = await authenticatedClient.delete<ChannelDeletionCounts>(
      `${CHANNELS_PATH}/${encodeURIComponent(oxyUserId)}/content`,
    );
    return res.data;
  }
}

export const channelDeletionService = new ChannelDeletionService();
