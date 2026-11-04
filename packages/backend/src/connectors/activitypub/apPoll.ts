import type { FederatedPollChoices } from '../../db/polls/pollRepository';
import { primaryApType } from './apSchemas';
import { asRecord } from './helpers';

/**
 * A remote poll: an ActivityPub `Question` (Mastodon, Pleroma, Misskey, GoToSocial).
 *
 * The options are `oneOf` (one choice) or `anyOf` (several), each a `Note` whose
 * `name` is the choice and whose `replies.totalItems` is its tally. The deadline
 * is `endTime` while open and `closed` once ended (a datetime, or `true` on
 * some servers). A vote is a `Create(Note)` naming the choice, which is why a
 * choice's text is kept byte-for-byte: it is what a vote must repeat.
 */

/** More choices than any fediverse server offers; a longer list is not a poll we render. */
const MAX_FEDERATED_POLL_OPTIONS = 20;
/** Longer than any server's option limit; a longer choice is refused, never truncated. */
const MAX_FEDERATED_POLL_OPTION_LENGTH = 500;
/**
 * The deadline of a poll that has none (Misskey's polls may never expire).
 * `polls.ends_at` is NOT NULL, and nothing renders a remaining time, only
 * whether the poll has ended.
 */
const OPEN_ENDED_POLL_ENDS_AT = new Date('9999-12-31T23:59:59.000Z');

function parseApDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pollEndsAt(object: Record<string, unknown>): Date {
  const closed = parseApDate(object.closed);
  if (closed) return closed;
  const endTime = parseApDate(object.endTime);
  if (object.closed === true) {
    const now = new Date();
    return endTime && endTime < now ? endTime : now;
  }
  return endTime ?? OPEN_ENDED_POLL_ENDS_AT;
}

/**
 * The poll a `Question` carries, or null for any other object and for a
 * `Question` whose choices are missing or out of bounds (stored as a plain post).
 */
export function extractApPoll(object: Record<string, unknown>): FederatedPollChoices | null {
  if (primaryApType(object.type) !== 'Question') return null;
  const isMultipleChoice = Array.isArray(object.anyOf);
  const choices = isMultipleChoice ? object.anyOf : object.oneOf;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  if (choices.length > MAX_FEDERATED_POLL_OPTIONS) return null;

  const options: Array<{ text: string; votes: number }> = [];
  for (const choice of choices) {
    const record = asRecord(choice);
    const text = record?.name;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    if (text.length > MAX_FEDERATED_POLL_OPTION_LENGTH) return null;
    const total = asRecord(record?.replies)?.totalItems;
    const votes = typeof total === 'number' && Number.isSafeInteger(total) && total > 0 ? total : 0;
    options.push({ text, votes });
  }

  return { options, isMultipleChoice, endsAt: pollEndsAt(object) };
}
