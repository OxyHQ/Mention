import { Router, type Response } from 'express';
import { z } from 'zod';
import { type OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { CrowdSourceApiError, CrowdSourceError } from '@oxy.so/crowdsource';
import {
  COMMUNITY_NOTE_HELPFUL_REASONS,
  COMMUNITY_NOTE_NOT_HELPFUL_REASONS,
} from '@mention/shared-types';
import {
  CommunityNotesUnavailableError,
  communityNotesEnabled,
  communityNotesRatedBy,
  communityNotesWrittenBy,
  drawCommunityNotesToRate,
  rateCommunityNote,
  withdrawCommunityNote,
  writeCommunityNote,
  type CommunityNoteRatingInput,
} from '../services/communityNotes/CommunityNotesService';
import {
  resolveNoteSubject,
  withSubjectPosts,
  type NoteSubjectRefusal,
} from '../services/communityNotes/communityNoteSubjects';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { requestLanguageCandidates } from '../utils/viewerLanguage';

/**
 * `/api/community-notes` — the viewer's side of community notes.
 *
 * Every route here forwards to CrowdSource, which owns notes, ratings and the
 * anonymity of both. Mention adds exactly two things no forwarder could: it
 * knows WHO is asking (the Oxy session — CrowdSource is told a principal id and
 * must be able to trust it), and it knows what a post id means, so the hub can
 * render the posts the notes are about.
 *
 * ## The mount is the authentication
 *
 * These are all under `authenticatedApi`. A note and a rating are acts of a
 * person, and a route that accepted a principal id from the body would let any
 * caller write notes as anyone.
 */

const router = Router();

/** CrowdSource's own cap on a note body. Restated so a 400 costs no round trip. */
const NOTE_TEXT_MAX_LENGTH = 500;
/** Sources a note may cite. */
const NOTE_SOURCES_MAX = 3;

const writeNoteSchema = z.object({
  postId: z.string().min(1),
  text: z.string().trim().min(1).max(NOTE_TEXT_MAX_LENGTH),
  sourceUrls: z.array(z.url()).max(NOTE_SOURCES_MAX).default([]),
  /**
   * The language the note is WRITTEN in, which is not necessarily the reader's
   * or the post's: a note is offered to raters who can read it, so getting this
   * from the client that typed it beats inferring it. Absent, the request's own
   * language ladder answers.
   */
  language: z.string().min(2).max(35).optional(),
});

/**
 * A rating and its reasons, checked against each other.
 *
 * The same discriminated union the CrowdSource contract uses, restated here
 * because this is the edge: "reliable source" is not a reason something is
 * unhelpful, and the narrowing has to happen once, where the untrusted body is
 * parsed, rather than at the SDK call where it would be a cast.
 */
const rateNoteSchema = z.discriminatedUnion('rating', [
  z.object({
    rating: z.literal('helpful'),
    reasons: z.array(z.enum(COMMUNITY_NOTE_HELPFUL_REASONS)).min(1).max(COMMUNITY_NOTE_HELPFUL_REASONS.length),
  }),
  z.object({
    rating: z.literal('not_helpful'),
    reasons: z.array(z.enum(COMMUNITY_NOTE_NOT_HELPFUL_REASONS)).min(1).max(COMMUNITY_NOTE_NOT_HELPFUL_REASONS.length),
  }),
]);

/**
 * One assignment window per rater per hour.
 *
 * Drawing notes is not idempotent by nature — two draws for one rater are two
 * different requests — so the SDK requires a key from the caller, and WHICH key
 * decides what the hub does. A per-request key would consume a fresh batch on
 * every reload, which is how a rater ends up holding forty half-read
 * assignments. Keyed by the hour, a reload re-reads the same queue and the next
 * hour offers new notes; a note already rated is never reissued, so the queue
 * drains rather than repeating.
 */
function assignmentWindowKey(viewerId: string, now: Date): string {
  return `community-note-draw.${viewerId}.${now.toISOString().slice(0, 13)}`;
}

/** Whatever went wrong, said once, without leaking CrowdSource's shape to the client. */
function fail(res: Response, operation: string, error: unknown): Response {
  if (error instanceof CommunityNotesUnavailableError) {
    // Not an error the reader caused, and not one they can act on: the feature
    // is simply not switched on in this deployment.
    return res.status(503).json({ message: 'Community notes are unavailable' });
  }
  if (error instanceof CrowdSourceApiError) {
    logger.warn('[CommunityNotes] refused by CrowdSource', { operation, code: error.code, status: error.status });
    // A refusal the caller can do something about is passed through as itself;
    // anything else is ours, not theirs. `conflict` is the rating that already
    // exists and the note that was already written — both mean "you have
    // already done this", which is exactly what a 409 says.
    if (error.status === 404) return res.status(404).json({ message: 'Not found' });
    if (error.status === 409) return res.status(409).json({ message: 'Already recorded' });
    if (error.status === 422 || error.status === 400) {
      return res.status(400).json({ message: 'Community notes refused this request', code: error.code });
    }
    if (error.status === 429) return res.status(429).json({ message: 'Too many notes for today' });
    return res.status(502).json({ message: 'Community notes are unavailable' });
  }
  logger.error('[CommunityNotes] request failed', {
    operation,
    retryable: error instanceof CrowdSourceError ? error.retryable : undefined,
  });
  return res.status(502).json({ message: 'Community notes are unavailable' });
}

/** What a refused subject means to the caller. */
const SUBJECT_REFUSALS: Record<NoteSubjectRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Post not found' },
  not_public: { status: 403, message: 'Only a public post can take community notes' },
  // Not the caller's doing and not fixable by them: a legacy federated post with
  // no Oxy author link cannot have its author kept out of the raters.
  no_author: { status: 409, message: 'This post cannot take community notes' },
  own_post: { status: 403, message: 'You cannot write a note on your own post' },
};

/**
 * `GET /api/community-notes/availability` — whether the flows may be offered.
 *
 * The app asks before it shows "Add community note" in a post's menu, because a
 * menu entry that opens a form no one will receive is worse than no entry.
 */
router.get('/availability', (_req: AuthRequest, res: Response) => {
  res.json({ enabled: communityNotesEnabled() });
});

/** `POST /api/community-notes` — write a note about a post. */
router.post('/', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = writeNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
  }
  const { postId, text, sourceUrls, language } = parsed.data;

  try {
    const subject = await resolveNoteSubject(viewerId, postId, createScopedOxyClient(req));
    if (!subject.ok) {
      const refusal = SUBJECT_REFUSALS[subject.refusal];
      return res.status(refusal.status).json({ message: refusal.message });
    }

    const note = await writeCommunityNote({
      viewerId,
      postId,
      postAuthorId: subject.authorPrincipalId,
      language: language ?? requestLanguageCandidates(req)[0] ?? 'en',
      text,
      sourceUrls,
    });
    return res.status(201).json({ note });
  } catch (error: unknown) {
    return fail(res, 'write', error);
  }
});

/** `POST /api/community-notes/:noteId/withdraw` — take your own note back. */
router.post('/:noteId/withdraw', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });
  const noteId = String(req.params.noteId ?? '');
  if (!noteId) return res.status(400).json({ message: 'Invalid note id' });

  try {
    const note = await withdrawCommunityNote(viewerId, noteId);
    return res.json({ note });
  } catch (error: unknown) {
    return fail(res, 'withdraw', error);
  }
});

/** `POST /api/community-notes/:noteId/ratings` — rate a note you were assigned. */
router.post('/:noteId/ratings', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });
  const noteId = String(req.params.noteId ?? '');
  if (!noteId) return res.status(400).json({ message: 'Invalid note id' });

  const parsed = rateNoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
  }

  try {
    await rateCommunityNote(viewerId, noteId, parsed.data as CommunityNoteRatingInput);
    return res.status(204).end();
  } catch (error: unknown) {
    return fail(res, 'rate', error);
  }
});

/**
 * `POST /api/community-notes/to-rate` — the viewer's rating queue.
 *
 * A POST because drawing ISSUES assignments: until CrowdSource has handed a note
 * to this rater, no rating from them is accepted. It reads like a list and is
 * not one.
 */
router.post('/to-rate', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const drawn = await drawCommunityNotesToRate(
      viewerId,
      requestLanguageCandidates(req),
      assignmentWindowKey(viewerId, new Date()),
    );
    const entries = await withSubjectPosts(viewerId, createScopedOxyClient(req), drawn);
    const expiryByNote = new Map(drawn.map((entry) => [entry.note.id, entry.expiresAt]));
    return res.json({
      entries: entries.map((entry) => ({ ...entry, expiresAt: expiryByNote.get(entry.note.id) })),
    });
  } catch (error: unknown) {
    return fail(res, 'draw', error);
  }
});

/** `GET /api/community-notes/mine` — the notes the viewer wrote. */
router.get('/mine', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const entries = await withSubjectPosts(viewerId, createScopedOxyClient(req), await communityNotesWrittenBy(viewerId));
    return res.json({ entries });
  } catch (error: unknown) {
    return fail(res, 'written', error);
  }
});

/** `GET /api/community-notes/ratings` — the notes the viewer rated. */
router.get('/ratings', async (req: AuthRequest, res: Response) => {
  const viewerId = req.user?.id;
  if (!viewerId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const entries = await withSubjectPosts(viewerId, createScopedOxyClient(req), await communityNotesRatedBy(viewerId));
    return res.json({ entries });
  } catch (error: unknown) {
    return fail(res, 'rated', error);
  }
});

export default router;
