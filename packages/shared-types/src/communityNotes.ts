/**
 * Community notes: context written and rated by readers, shown under a post
 * once enough raters agree it is helpful.
 *
 * Ownership split: CrowdSource owns everything about a note — authorship,
 * ratings, the rule that decides whether a note is shown, and the anonymity of
 * writers and raters. Mention stores none of it. It renders the note CrowdSource
 * attaches to a post and forwards the viewer's writes (a new note, a rating) to
 * CrowdSource, exactly as it forwards reports.
 *
 * The DTO therefore carries no writer or rater identity, ever.
 */

/**
 * Where a note stands, as CrowdSource scored it.
 *
 * `shown`: raters of different viewpoints found it helpful, and it is displayed
 * under the post to everyone. `needs_ratings`: still collecting. `not_shown`:
 * rated unhelpful. `withdrawn`: its writer took it back.
 *
 * Only `shown` reaches a reader — the other three exist because the writer's own
 * list has to be able to say what became of a note. A status is a scoring
 * outcome, never a verdict on the writer, and it can move again as ratings
 * arrive.
 */
export type CommunityNoteStatus = 'shown' | 'needs_ratings' | 'not_shown' | 'withdrawn';

export type CommunityNoteRating = 'helpful' | 'not_helpful';

/** Why a rater found a note helpful. */
export const COMMUNITY_NOTE_HELPFUL_REASONS = [
  'full_explanation',
  'relevant',
  'reliable_source',
  'neutral',
  'easy_to_understand',
  'other',
] as const;
export type CommunityNoteHelpfulReason = (typeof COMMUNITY_NOTE_HELPFUL_REASONS)[number];

/** Why a rater found a note not helpful. */
export const COMMUNITY_NOTE_NOT_HELPFUL_REASONS = [
  'incorrect',
  'unreliable_source',
  'missing_key_points',
  'opinion_or_biased',
  'hard_to_understand',
  'not_needed',
  'other',
] as const;
export type CommunityNoteNotHelpfulReason = (typeof COMMUNITY_NOTE_NOT_HELPFUL_REASONS)[number];

export interface CommunityNoteSummary {
  id: string;
  /** The note body, in the language CrowdSource resolved for this reader. */
  text: string;
  /** Sources the writer cited, in order. */
  sourceUrls: string[];
  status: CommunityNoteStatus;
  createdAt: string;
  /** The viewer's own rating, when they rated it. Ratings cannot be changed. */
  viewerRating?: CommunityNoteRating;
}
