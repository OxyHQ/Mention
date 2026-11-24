import { z } from 'zod';
import { mirrorPostKey } from '../../utils/federation/mirrorTransports';
import { getJson } from './xTimeline';

/**
 * THE FULL TEXT OF A LONG TWEET, WHEN THE BRIDGE DELIVERED IT CUT.
 *
 * A tweet over X's classic 280 characters is a "note tweet". The bridges
 * (bird.makeup, mastox.eu) sometimes publish only its classic prefix, cut at
 * ~277 characters mid-sentence, and Mention stores the body exactly as it
 * arrives, so the post stays cut for good. Measured on 120 recent bridged posts:
 * 8 were cut, all note tweets, and a second request to bird.makeup returned the
 * full text for only 3 of 5 of them.
 *
 * FxTwitter's public status endpoint answers a tweet by id, with the whole
 * text and an `is_note_tweet` flag. This module takes ONLY that text, only for
 * a note tweet, to complete a body the bridge cut: the post itself (author,
 * media, quote, upstream key) is still the bridge's Note, as
 * `xTimeline.ts` explains. Nothing else of FxTwitter's JSON is read.
 */

const FXTWITTER_STATUS_API = 'https://api.fxtwitter.com/i/status';

/**
 * No body shorter than this can be a cut note: X cuts a note at its classic
 * limit (277 to 280 characters seen). The bound keeps the extra request to the
 * few posts that can need it, the way a body of 120 characters never does.
 */
export const CUT_NOTE_MIN_LENGTH = 250;

/** The trailing run of bare links the bridge puts after the prose (the quoted tweet's). */
const TRAILING_LINKS = /(?:\s*https?:\/\/\S+)+\s*$/;

const noteTweetSchema = z
  .object({
    code: z.literal(200),
    tweet: z.object({ is_note_tweet: z.literal(true), text: z.string().min(1) }).loose(),
  })
  .loose();

/** Whether a stored body is long enough to be a cut note tweet. */
export function mayBeCutNote(body: string): boolean {
  return body.length >= CUT_NOTE_MIN_LENGTH;
}

/**
 * The text of note tweet `tweetId`, in full. Undefined when the tweet is not a
 * note (it was never cut) or FxTwitter cannot answer: the caller keeps the body
 * it has.
 */
export async function fetchNoteTweetText(tweetId: string): Promise<string | undefined> {
  const parsed = noteTweetSchema.safeParse(await getJson(`${FXTWITTER_STATUS_API}/${tweetId}`));
  return parsed.success ? parsed.data.tweet.text : undefined;
}

/**
 * `body` with the cut prose replaced by `fullText`, keeping the bridge's
 * trailing links (the quoted tweet's) that the full text does not already carry.
 * Undefined when the full text is no longer than the prose it replaces.
 */
export function completeCutBody(body: string, fullText: string): string | undefined {
  const links = TRAILING_LINKS.exec(body)?.[0] ?? '';
  const prose = body.slice(0, body.length - links.length);
  if (fullText.length <= prose.length) return undefined;
  const kept = [...links.matchAll(/https?:\/\/\S+/g)]
    .map(([link]) => link)
    .filter((link) => !fullText.includes(link));
  return [fullText, ...kept].join('\n');
}

/** The tweet id of a Note a bridge republishes from X, or undefined for any other Note. */
export function bridgedTweetId(noteId: unknown): string | undefined {
  const key = typeof noteId === 'string' ? mirrorPostKey(noteId) : undefined;
  return key?.startsWith('x:') ? key.slice(2) : undefined;
}

/**
 * The body a bridged tweet should be stored with: `body` itself unless it is a
 * note tweet the bridge cut, in which case the full text. One request, and only
 * for a body long enough to be cut.
 */
export async function completeBridgedBody(noteId: unknown, body: string): Promise<string> {
  const tweetId = bridgedTweetId(noteId);
  if (!tweetId || !mayBeCutNote(body)) return body;
  const fullText = await fetchNoteTweetText(tweetId);
  return (fullText && completeCutBody(body, fullText)) ?? body;
}
