import { CrowdSourceApiError, CrowdSourceError } from '@crowdsource.you/core';
import type { CommunityNote, CommunityNoteStatus } from '@crowdsource.you/contracts';
import type {
  CommunityNoteHelpfulReason,
  CommunityNoteNotHelpfulReason,
  CommunityNoteRating,
  CommunityNoteStatus as MentionNoteStatus,
  CommunityNoteSummary,
} from '@mention/shared-types';
import { createCache } from '../../utils/cache';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { getCrowdSourceClient } from '../moderation/crowdSourceClient';

/**
 * Community notes, from Mention's side of the line.
 *
 * CrowdSource owns notes entirely — who wrote one, who rated it, the model that
 * decides whether it is shown, and the anonymity of both. Mention stores NOTHING:
 * no table, no column, no cached rating. This module is a translator and nothing
 * more. It turns a Mention post id into a subject id, a viewer into a principal,
 * and a CrowdSource note into the DTO the app renders.
 *
 * ## Why the viewer's Oxy id is the principal id
 *
 * The same identity Mention already sends with a report (`reportedBy.oxyUserId`,
 * §11.14): CrowdSource is first-party infrastructure and a note's principal is
 * stored to enforce the exclusions the design needs — a writer never rates their
 * own note, a post's author never rates a note about their post, a writer has a
 * daily cap — none of which is enforceable against an id that changes. It is
 * never returned on a note, never written to an audit row and never logged;
 * that is a CrowdSource guarantee, and it is why a second, Mention-side
 * pseudonym would buy privacy from nobody while making a note unattributable to
 * its writer the moment the pepper was rotated.
 *
 * ## Reads fail open, writes fail loud
 *
 * A feed page whose note lookup timed out is a feed page without notes, which is
 * what every page looked like before this existed. A note the writer typed and
 * sent is different: swallowing that failure would show them a "submitted" sheet
 * for a note that went nowhere, so a write reports what happened.
 */

/** The longest a shown-note lookup is served from Redis. */
const SHOWN_NOTE_TTL_SECONDS = 300;
/** CrowdSource takes at most 50 subjects per lookup. */
const SUBJECTS_PER_LOOKUP = 50;
/** Languages a rater may be handed notes in. CrowdSource's own cap. */
const RATER_LANGUAGES_MAX = 5;
/** Notes one draw asks for. */
const ASSIGNMENT_BATCH = 10;

/**
 * `v1` is the DTO shape, not the note: a note whose STATUS changed is evicted by
 * the webhook, and a note whose text changed cannot exist (notes are not
 * editable). The version is here so a change to what Mention stores per subject
 * invalidates the old entries instead of being read back as the new shape.
 */
const SHOWN_NOTE_PREFIX = 'communitynote:shown:v1:';

/** `null` is a real answer — "this post has no shown note" — and is cached too. */
type CachedNote = CommunityNoteSummary | null;

const shownNoteCache = createCache({
  name: 'CommunityNoteShownCache',
  ttlSeconds: SHOWN_NOTE_TTL_SECONDS,
});

function keyFor(postId: string): string {
  return `${SHOWN_NOTE_PREFIX}${postId}`;
}

/**
 * CrowdSource's four statuses, unchanged.
 *
 * Mention's DTO carries all four because the writer's own list has to say what
 * became of a note. A reader only ever receives `shown` — that is enforced by
 * WHICH CrowdSource call is made (the `shown` lookup returns nothing else), not
 * by filtering here, so there is no place where a mistake could let an unshown
 * note reach a feed.
 */
function toMentionStatus(status: CommunityNoteStatus): MentionNoteStatus {
  return status;
}

/** A CrowdSource note as the app renders it. Carries no principal, because none arrives. */
function toSummary(note: CommunityNote, viewerRating?: CommunityNoteRating): CommunityNoteSummary {
  return {
    id: note.id,
    text: note.text,
    sourceUrls: [...note.sourceUrls],
    status: toMentionStatus(note.status),
    createdAt: note.createdAt,
    ...(viewerRating === undefined ? {} : { viewerRating }),
  };
}

/** Whether the integration can serve anything at all. */
export function communityNotesEnabled(): boolean {
  return getCrowdSourceClient() !== undefined;
}

function recordFailure(operation: string, error: unknown): void {
  const code = error instanceof CrowdSourceApiError ? error.code : 'transport';
  metrics.incrementCounter('crowdsource_community_notes_failure_total', 1, { operation, code });
  logger.warn('[CommunityNotes] CrowdSource call failed', {
    operation,
    code,
    retryable: error instanceof CrowdSourceError ? error.retryable : undefined,
  });
}

/**
 * The shown note for each of `postIds`, for any post that has one.
 *
 * ONE CrowdSource call per 50 posts, behind a Redis cache with a negative entry
 * for a post with no note — a feed page is overwhelmingly posts with no note,
 * and without that entry every page would ask about all of them every time.
 *
 * Fails open: a CrowdSource outage is an empty map, never an error, and never a
 * cached empty map (a miss that was really a failure must not be remembered as
 * "this post has no note").
 */
export async function loadShownNotes(postIds: readonly string[]): Promise<Map<string, CommunityNoteSummary>> {
  const attached = new Map<string, CommunityNoteSummary>();
  const client = getCrowdSourceClient();
  if (!client || postIds.length === 0) return attached;

  const unique = [...new Set(postIds)].filter((id) => id.length > 0);
  if (unique.length === 0) return attached;

  const cached = await shownNoteCache.getMany<CachedNote>(unique.map(keyFor));
  const misses: string[] = [];
  unique.forEach((postId, index) => {
    const entry = cached[index];
    if (entry === undefined) {
      misses.push(postId);
      return;
    }
    if (entry !== null) attached.set(postId, entry);
  });

  for (let start = 0; start < misses.length; start += SUBJECTS_PER_LOOKUP) {
    const batch = misses.slice(start, start + SUBJECTS_PER_LOOKUP);
    let notes: CommunityNote[];
    try {
      notes = await client.communityNotes.shown(batch);
    } catch (error: unknown) {
      recordFailure('shown', error);
      // The rest of the page still gets the notes already resolved. Nothing is
      // written to the cache for this batch: the answer is unknown, not "none".
      continue;
    }

    const writes: [string, CachedNote][] = batch.map((postId) => [keyFor(postId), null]);
    for (const note of notes) {
      const summary = toSummary(note);
      attached.set(note.externalSubjectId, summary);
      const index = batch.indexOf(note.externalSubjectId);
      // A note for a subject nobody asked about cannot be attached to a post on
      // this page, so it is not cached under one either.
      if (index >= 0) writes[index] = [keyFor(note.externalSubjectId), summary];
    }
    await shownNoteCache.setMany(writes);
  }

  return attached;
}

/** Forget a post's shown note, so the next reader asks CrowdSource again. */
export async function invalidateShownNote(postId: string): Promise<void> {
  if (!postId) return;
  await shownNoteCache.delete([keyFor(postId)]);
}

/** Raised when the integration is switched off and a caller needs an answer. */
export class CommunityNotesUnavailableError extends Error {
  constructor() {
    super('Community notes are not configured');
    this.name = 'CommunityNotesUnavailableError';
  }
}

function requireClient() {
  const client = getCrowdSourceClient();
  if (!client) throw new CommunityNotesUnavailableError();
  return client;
}

export interface WriteCommunityNoteInput {
  viewerId: string;
  postId: string;
  postAuthorId: string;
  language: string;
  text: string;
  sourceUrls: string[];
}

/**
 * Writes the viewer's note about a post.
 *
 * The post's author travels with it because CrowdSource cannot enforce "the
 * author of a post never rates a note about it" unless the note says who that
 * is. Idempotency is the SDK's: one note per writer per subject, so a retry of
 * the same send returns the note it already wrote rather than a second one.
 */
export async function writeCommunityNote(input: WriteCommunityNoteInput): Promise<CommunityNoteSummary> {
  const client = requireClient();
  const note = await client.communityNotes.write({
    externalSubjectId: input.postId,
    subjectAuthorPrincipalId: input.postAuthorId,
    authorPrincipalId: input.viewerId,
    language: input.language,
    text: input.text,
    sourceUrls: input.sourceUrls,
  });
  // A brand-new note is `needs_ratings`, so nothing on the post changes yet —
  // but the negative entry cached for this post would outlive the note becoming
  // shown if the webhook were missed, and dropping it costs one Redis delete.
  await invalidateShownNote(input.postId);
  return toSummary(note);
}

/** Takes the viewer's own note back. Anyone else's note is a 404 from CrowdSource. */
export async function withdrawCommunityNote(viewerId: string, noteId: string): Promise<CommunityNoteSummary> {
  const client = requireClient();
  const note = await client.communityNotes.withdraw(noteId, viewerId);
  await invalidateShownNote(note.externalSubjectId);
  return toSummary(note);
}

export interface DrawnCommunityNote {
  /** The subject the note is about — a Mention post id. */
  postId: string;
  note: CommunityNoteSummary;
  /** After this, the assignment lapses and the rating is refused. */
  expiresAt: string;
}

/**
 * Draws notes for the viewer to rate.
 *
 * `requestKey` is required by the SDK and is the caller's: two draws for one
 * rater are two different requests, so there is nothing about the draw itself
 * from which a key could be derived. The route sends the rater and the hour, so
 * a reloaded hub re-reads the same queue instead of consuming a new one.
 */
export async function drawCommunityNotesToRate(
  viewerId: string,
  languages: readonly string[],
  requestKey: string,
): Promise<DrawnCommunityNote[]> {
  const client = requireClient();
  const wanted = [...new Set(languages)].slice(0, RATER_LANGUAGES_MAX);
  const assignments = await client.communityNotes.drawToRate(
    {
      raterPrincipalId: viewerId,
      // A rater with no readable language declaration is not handed notes in a
      // language they cannot judge; `en` is the fallback the rest of the
      // language ladder ends at.
      languages: wanted.length > 0 ? wanted : ['en'],
      limit: ASSIGNMENT_BATCH,
    },
    { idempotencyKey: requestKey },
  );
  return assignments.map((assignment) => ({
    postId: assignment.note.externalSubjectId,
    note: toSummary(assignment.note),
    expiresAt: assignment.expiresAt,
  }));
}

/**
 * A rating together with the reasons for it.
 *
 * A union rather than `{ rating, reasons: string[] }` for the reason the
 * contract's own schema is one: "reliable source" is not a reason something is
 * unhelpful, and a pair that says so should not compile. The route parses the
 * request into this, so the narrowing happens once, at the edge.
 */
export type CommunityNoteRatingInput =
  | { rating: 'helpful'; reasons: CommunityNoteHelpfulReason[] }
  | { rating: 'not_helpful'; reasons: CommunityNoteNotHelpfulReason[] };

/** Records the viewer's rating. Final: CrowdSource refuses a second one. */
export async function rateCommunityNote(
  viewerId: string,
  noteId: string,
  submission: CommunityNoteRatingInput,
): Promise<void> {
  const client = requireClient();
  await client.communityNotes.rate(noteId, { raterPrincipalId: viewerId, ...submission });
}

export interface CommunityNoteWithSubject {
  postId: string;
  note: CommunityNoteSummary;
}

/** The notes the viewer wrote, newest first. */
export async function communityNotesWrittenBy(viewerId: string): Promise<CommunityNoteWithSubject[]> {
  const client = requireClient();
  const notes = await client.communityNotes.writtenBy(viewerId);
  return notes.map((note) => ({ postId: note.externalSubjectId, note: toSummary(note) }));
}

/** The notes the viewer rated, each carrying the rating they gave. */
export async function communityNotesRatedBy(viewerId: string): Promise<CommunityNoteWithSubject[]> {
  const client = requireClient();
  const rated = await client.communityNotes.ratedBy(viewerId);
  return rated.map((entry) => ({
    postId: entry.note.externalSubjectId,
    note: toSummary(entry.note, entry.rating.rating),
  }));
}
