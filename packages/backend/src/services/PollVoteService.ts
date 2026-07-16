import Poll, { IPoll, IPollOption } from '../models/Poll';

/**
 * Why a vote could not be recorded. Callers map these to their own surface: the
 * HTTP controller to status codes, the ActivityPub inbox to a debug log + drop.
 */
export type PollVoteFailureReason =
  | 'poll_not_found'
  | 'poll_ended'
  | 'option_not_found'
  | 'already_voted';

export type PollVoteResult =
  | { ok: true; poll: IPoll }
  | { ok: false; reason: PollVoteFailureReason };

/**
 * The SINGLE authority for recording a vote on a {@link Poll} — shared by the
 * local HTTP vote route (`polls.controller`) and the inbound ActivityPub poll
 * vote handler (`inbox.service` — a remote Mastodon `Create(Note)` with a `name`
 * on our `Question`). Both resolve a voter and an option and then land here, so
 * dedup/one-per-voter, closed-poll rejection, and single-vs-multiple-choice
 * semantics live in ONE place and can never diverge between the two paths.
 *
 * Recording is a single ATOMIC `findOneAndUpdate` whose filter carries the
 * dedup guard, so a concurrent double-vote (or a redelivered federated vote)
 * can never double-count: the update matches only when the voter is not already
 * in the relevant `votes` set.
 */
class PollVoteService {
  /** Record a vote identified by the option's `_id` (the local HTTP vote route). */
  async recordVoteByOptionId(pollId: string, optionId: string, voterId: string): Promise<PollVoteResult> {
    const poll = await Poll.findById(pollId);
    if (!poll) return { ok: false, reason: 'poll_not_found' };
    if (this.hasEnded(poll)) return { ok: false, reason: 'poll_ended' };

    const option = poll.options.find((opt) => opt._id.toString() === optionId);
    if (!option) return { ok: false, reason: 'option_not_found' };

    return this.applyVote(poll, option, voterId);
  }

  /**
   * Record a vote identified by the option's TEXT (the inbound ActivityPub path:
   * a Mastodon poll vote references the chosen option by `name`, not by our id).
   */
  async recordVoteByOptionText(pollId: string, optionText: string, voterId: string): Promise<PollVoteResult> {
    const poll = await Poll.findById(pollId);
    if (!poll) return { ok: false, reason: 'poll_not_found' };
    if (this.hasEnded(poll)) return { ok: false, reason: 'poll_ended' };

    const option = poll.options.find((opt) => opt.text === optionText);
    if (!option) return { ok: false, reason: 'option_not_found' };

    return this.applyVote(poll, option, voterId);
  }

  private hasEnded(poll: IPoll): boolean {
    return new Date() > poll.endsAt;
  }

  /**
   * Atomically push the voter onto the option's `votes` set, guarded so a
   * duplicate never double-counts:
   *  - single-choice: only when the voter has voted on NO option yet;
   *  - multiple-choice: only when the voter has not voted on THIS option yet.
   *
   * `poll` is the pre-update snapshot used only to distinguish an already-voted
   * miss from an unknown-option miss on the single-choice path (mirrors the
   * original controller behavior).
   */
  private async applyVote(poll: IPoll, option: IPollOption, voterId: string): Promise<PollVoteResult> {
    const pollId = String(poll._id);
    const optionId = option._id.toString();

    if (!poll.isMultipleChoice) {
      const updated = await Poll.findOneAndUpdate(
        {
          _id: pollId,
          'options._id': optionId,
          'options.votes': { $ne: voterId }, // only if the voter has not voted on ANY option
        },
        { $push: { 'options.$.votes': voterId } },
        { new: true },
      );
      if (!updated) {
        const hasVoted = poll.options.some((opt) => opt.votes.some((vote) => vote.toString() === voterId));
        return { ok: false, reason: hasVoted ? 'already_voted' : 'option_not_found' };
      }
      return { ok: true, poll: updated };
    }

    const updated = await Poll.findOneAndUpdate(
      {
        _id: pollId,
        'options._id': optionId,
        options: { $not: { $elemMatch: { _id: optionId, votes: voterId } } }, // not already on THIS option
      },
      { $push: { 'options.$.votes': voterId } },
      { new: true },
    );
    if (!updated) return { ok: false, reason: 'already_voted' };
    return { ok: true, poll: updated };
  }
}

export const pollVoteService = new PollVoteService();
export default pollVoteService;
