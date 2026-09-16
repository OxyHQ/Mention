/**
 * The poll DTOs served by `/polls/*` (`polls.controller.ts`) — a dedicated
 * attachment resource, distinct from the compose-time `PollData` in
 * `post.ts` (which describes a poll embedded in `PostContent`/`HydratedPost`
 * before or during composition, not the standalone poll resource these
 * routes read and vote on).
 *
 * Field names on {@link PollDetail} follow the wire format
 * `polls.controller.ts` has always used — `_id`, `created_at`, `updated_at` —
 * because that is what `frontend/services/pollService.ts` has always read;
 * this file fixes what was AMBIGUOUS about that contract, not what merely
 * looks inconsistent with the rest of the API.
 */

/**
 * One option's tally. `voteCount` is unconditional and always a number — it
 * replaces a field that used to be an array of voter ids for a visible poll
 * and a bare count for an anonymous one, UNDER THE SAME NAME, which is what
 * crashed the poll card the first time an anonymous poll got a vote.
 *
 * No voter identities travel here, anonymous poll or not: nothing in the
 * frontend has ever rendered them, and embedding every voter's id in a
 * response every reader loads did not need a rendering bug to be worth
 * dropping. A future per-voter identity display is a paginated, authorized
 * read of its own — not a field riding along on every poll read and vote.
 */
export interface PollDetailOption {
  _id: string;
  text: string;
  voteCount: number;
}

/** A poll as `GET/POST /polls/:id`, `POST /polls` and `POST /polls/:id/update-post` all serve it. */
export interface PollDetail {
  _id: string;
  question: string;
  options: PollDetailOption[];
  /** Absent while the poll is a composer intermediate, not yet attached to a post. */
  postId?: string;
  createdBy: string;
  endsAt: string;
  isMultipleChoice: boolean;
  isAnonymous: boolean;
  created_at: string;
  updated_at: string;
  /**
   * The option ids THIS caller voted for, under their own authenticated
   * identity. Never another voter's — the one guarantee this field must
   * never weaken, anonymous poll or not. This is what makes "have I voted,
   * and on what" answerable without the array-or-count ambiguity
   * {@link PollDetailOption.voteCount} used to carry.
   */
  viewerSelectedOptionIds: string[];
}

export interface PollResultOption {
  id: string;
  text: string;
  voteCount: number;
  percentage: number;
}

/**
 * The `/polls/:id/results` response — deliberately a SEPARATE shape from
 * {@link PollDetail} rather than the same type reused loosely: the two
 * endpoints answer different questions (one poll's state for a voter, one
 * poll's tally for a reader) and drifted apart once already when nothing
 * enforced they must not.
 */
export interface PollResults {
  id: string;
  question: string;
  results: PollResultOption[];
  totalVotes: number;
  endsAt: string;
  isEnded: boolean;
  isAnonymous: boolean;
}
