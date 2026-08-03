import { authenticatedClient } from '@/utils/api';
import { noteChannelBylineChanged } from '@/stores/bylineInvalidation';

const SETTINGS_PATH = '/profile/settings';

/**
 * The Mention-owned settings of a channel ACCOUNT.
 *
 * Everything else about a channel — its handle, name, avatar, bio, and who may
 * operate it — is Oxy's, because a channel is an Oxy account and Oxy owns
 * identity. This is the one preference Mention has: whether a post the channel
 * publishes also names the person who wrote it. Oxy has no concept of signing a
 * post, so it cannot live there.
 */
export interface ChannelAccountSettings {
  /**
   * Whether a post published by this channel names its writer.
   *
   * `false` is the default and the safe one: the writer is anonymous behind the
   * channel unless its operator says otherwise. Getting that backwards discloses
   * every writer's identity by omission, so the read below treats anything but
   * an explicit `true` as off.
   */
  signPosts: boolean;
}

/**
 * A channel account's Mention-side settings, read and written by its operators.
 *
 * Keyed on the CHANNEL's `oxyUserId`, not on the caller's: a channel account has
 * no login of its own (it is a content identity, not a seat), so its operator
 * writes on its behalf and the server authorizes that against their membership.
 * That is why these are not `PUT /profile/settings`, which only ever writes the
 * caller's own row.
 *
 * Nothing here catches. A toggle that fails must say so — one that quietly does
 * nothing would leave an operator believing their writers are anonymous.
 */
class ChannelAccountService {
  /**
   * Read from `/channel` rather than from the bare `${SETTINGS_PATH}/:id` the
   * write below uses, because those two paths answer different questions.
   * `GET /profile/settings/:id` serves a VIEWER the profile-design DTO, and a
   * channel is never its own viewer — no session can be minted whose subject is a
   * channel — so that response never carries a `channel` block at all and this
   * read came back `false` however the operator had it set.
   */
  async getSettings(oxyUserId: string): Promise<ChannelAccountSettings> {
    const res = await authenticatedClient.get<{ channel?: Partial<ChannelAccountSettings> }>(
      `${SETTINGS_PATH}/${encodeURIComponent(oxyUserId)}/channel`,
    );
    return { signPosts: res.data?.channel?.signPosts === true };
  }

  /**
   * Flip whether this channel's posts name their writer — and REPORT it, because
   * the toggle rewrites the byline of every post the channel has ever published
   * and every cache holding one is now wrong.
   *
   * The report is made here, not in the screen's mutation handler, on the rule
   * this repo has already paid to learn: a signal sent from a caller is a signal
   * the next caller forgets. `postsStore` reports every engagement write for
   * exactly that reason, after two call sites that wrote through it without
   * touching the engagement hooks were found to be silent. This method is the ONE
   * place this fact is written, so it is the one place that can speak for it —
   * anything reaching for the toggle later (an onboarding step, a channel-creation
   * flow, a bulk operator tool) inherits the convergence rather than having to
   * remember it.
   *
   * After the await and only on success: a refused write leaves every surface
   * exactly as the caches already have it, and a throw here would never reach the
   * report at all.
   */
  async setSignPosts(oxyUserId: string, signPosts: boolean): Promise<ChannelAccountSettings> {
    const res = await authenticatedClient.put<{ channel?: Partial<ChannelAccountSettings> }>(
      `${SETTINGS_PATH}/${encodeURIComponent(oxyUserId)}`,
      { channel: { signPosts } },
    );
    noteChannelBylineChanged(oxyUserId);
    // The server's own answer wins when it sends one; the requested value is the
    // fallback so a terse 200 does not flip the switch back under the operator.
    return { signPosts: res.data?.channel?.signPosts ?? signPosts };
  }
}

export const channelAccountService = new ChannelAccountService();
