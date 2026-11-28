// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { z } from 'zod';
import { mirrorPostKey } from '../../utils/federation/mirrorTransports';
import { sleep } from '../../utils/sleep';
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
 * limit (277 to 280 characters seen), and a cut body stored shorter than that
 * (229 seen) had links or mentions that the stored text spells shorter. The bound
 * keeps the extra request to the posts that can need it, the way a body of 120
 * characters never does.
 */
export const CUT_NOTE_MIN_LENGTH = 200;

/** The trailing run of bare links the bridge puts after the prose (the quoted tweet's). */
const TRAILING_LINKS = /(?:\s*https?:\/\/\S+)+\s*$/;

const tweetSchema = z
  .object({
    code: z.literal(200),
    tweet: z.object({ is_note_tweet: z.boolean(), text: z.string() }).loose(),
  })
  .loose();

/** Whether a stored body is long enough to be a cut note tweet. */
export function mayBeCutNote(body: string): boolean {
  return body.length >= CUT_NOTE_MIN_LENGTH;
}

/**
 * What FxTwitter said about one tweet. `answered: false` is a failure to learn
 * (a flaky 404, a rate limit, a timeout), which must never be read as "not a
 * note": the body would stay cut with no trace. `text` is present only for a
 * note tweet, and is its full text.
 */
export type NoteTweetAnswer = { answered: false } | { answered: true; text?: string };

export async function fetchNoteTweetText(tweetId: string): Promise<NoteTweetAnswer> {
  const parsed = tweetSchema.safeParse(await getJson(`${FXTWITTER_STATUS_API}/${tweetId}`));
  if (!parsed.success) return { answered: false };
  const { is_note_tweet: isNote, text } = parsed.data.tweet;
  return { answered: true, ...(isNote && text.length > 0 ? { text } : {}) };
}

/** The bridge's resolved-mention placeholder (`[mention:<oxy user id>]`) inside a stored body. */
const MENTION_PLACEHOLDER = /\[mention:[^\]]+\]/g;

/**
 * Characters of the cut prose that locate where it ends in the full text. Long
 * enough to be unambiguous, short enough to fit after the last placeholder.
 */
const ANCHOR_LENGTH = 40;
const MIN_ANCHOR_LENGTH = 12;

/**
 * `body` extended with the part of `fullText` it is missing. The cut prose is
 * kept as stored, so its resolved-mention placeholders survive, and only the
 * suffix after the point where the prose ends is taken from the full text; the
 * bridge's trailing links (the quoted tweet's) that the full text does not carry
 * stay. Undefined when that point cannot be found, or nothing is missing.
 */
export function completeCutBody(body: string, fullText: string): string | undefined {
  const links = TRAILING_LINKS.exec(body)?.[0] ?? '';
  const prose = body.slice(0, body.length - links.length).trimEnd();
  const afterMention = prose.split(MENTION_PLACEHOLDER).at(-1) ?? '';
  const anchor = afterMention.slice(-ANCHOR_LENGTH);
  if (anchor.length < MIN_ANCHOR_LENGTH) return undefined;
  const at = fullText.indexOf(anchor);
  if (at === -1) return undefined;
  const suffix = fullText.slice(at + anchor.length);
  if (suffix.trim().length === 0) return undefined;
  const kept = [...links.matchAll(/https?:\/\/\S+/g)]
    .map(([link]) => link)
    .filter((link) => !fullText.includes(link));
  return [prose + suffix, ...kept].join('\n');
}

/** The tweet id of a Note a bridge republishes from X, or undefined for any other Note. */
export function bridgedTweetId(noteId: unknown): string | undefined {
  const key = typeof noteId === 'string' ? mirrorPostKey(noteId) : undefined;
  return key?.startsWith('x:') ? key.slice(2) : undefined;
}

export interface BridgedBody {
  body: string;
  /** False when a body that may be cut could not be checked: FxTwitter never answered. */
  answered: boolean;
}

/**
 * The body a bridged tweet should be stored with: `body` itself unless it is a
 * note tweet the bridge cut, in which case the full text. Only a body long enough
 * to be cut is checked. Ingest asks once; a repair passes `attempts` so a flaky
 * answer is retried (with a growing pause) instead of leaving the body cut.
 */
export async function resolveBridgedBody(
  noteId: unknown,
  body: string,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<BridgedBody> {
  const tweetId = bridgedTweetId(noteId);
  if (!tweetId || !mayBeCutNote(body)) return { body, answered: true };
  const attempts = options.attempts ?? 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await fetchNoteTweetText(tweetId);
    if (answer.answered) {
      return { body: (answer.text && completeCutBody(body, answer.text)) ?? body, answered: true };
    }
    if (attempt < attempts) await sleep((options.retryDelayMs ?? 1_000) * attempt);
  }
  return { body, answered: false };
}

/** {@link resolveBridgedBody} for ingest: one request, the body it should be stored with. */
export async function completeBridgedBody(noteId: unknown, body: string): Promise<string> {
  return (await resolveBridgedBody(noteId, body)).body;
}
