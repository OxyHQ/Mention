/**
 * Ids that SHARE a millisecond and whose relative order is fixed by
 * construction.
 *
 * ## The belief this exists to retire
 *
 * Several ranking and pagination suites created two rows back to back and then
 * asserted which one led, justified by a comment saying "uuid v7 is monotonic,
 * so the later insert leads". **It is not.** `@oxyhq/db`'s `uuidv7()` is 48
 * bits of `Date.now()` followed by
 * `randomFillSync` — RFC 9562's optional monotonic counter (the `rand_a`
 * "method 2" sub-millisecond sequence) is NOT implemented, and
 * `db/posts/postRepository.ts` already says so where it explains why an
 * authorship byline cannot be recovered from id order.
 *
 * Two ids minted in the same millisecond therefore order on their RANDOM tail.
 * Measured on this implementation: 19,967 of 20,000 back-to-back in-process
 * pairs shared a millisecond, and 49.3% of those put the EARLIER id first — a
 * coin flip, not a rare edge. A sibling suite
 * (`services/profileLinkMentionWrites.test.ts`) had already measured the same
 * thing the hard way, at 4 passes to 6 failures over ten runs of one file.
 *
 * Those suites passed only because a database round trip usually pushes two
 * inserts into different milliseconds. That is latency, not a guarantee: it
 * makes the assertion a coin flip exactly when the round trip is fast, so the
 * failure arrives at random, months later, looking like a ranking or pagination
 * regression rather than a fixture.
 *
 * ## What this does instead
 *
 * `posts.id` is supplied by the caller when `PostRecordInput.id` is set, so a
 * fixture can state the tie rather than hope for it. Every id from ONE call
 * carries the same 48-bit timestamp and differs only in `rand_a`, which sits
 * immediately after it — so the ids are strictly ascending with their index,
 * and the pair is a genuine same-millisecond tie of exactly the kind the
 * production tiebreak exists to resolve. Spacing the writes across milliseconds
 * would have been the other way to make the fixture deterministic, but it
 * removes the very case under test.
 *
 * `rand_b` (bytes 9-15) stays random, because vitest runs these files in
 * parallel against ONE database and a fixed tail would collide between suites.
 *
 * The ids are real uuid v7 values — correct version nibble and RFC 9562
 * variant — so every shape check that tells a post-cutover id from a 24-char
 * ObjectId hex still classifies them correctly.
 */

import { randomFillSync } from 'node:crypto';

const UUID_BYTES = 16;
const UUID_V7_TIMESTAMP_BYTES = 6;

/**
 * `rand_a` is 12 bits — byte 6's low nibble plus byte 7 — so it addresses 4096
 * ids within one millisecond. Every fixture here wants a handful.
 */
const MAX_ORDINAL = 0x0fff;

/**
 * `count` uuid v7 ids sharing one millisecond, strictly ascending.
 *
 * Index 0 is the LOWEST id, so a `desc(id)` tiebreak puts the LAST element
 * first. Callers name the two ends rather than relying on insertion order.
 */
export function sameMillisecondIds(count: number): string[] {
  if (!Number.isInteger(count) || count < 2 || count > MAX_ORDINAL + 1) {
    throw new RangeError(`sameMillisecondIds needs an integer 2..${MAX_ORDINAL + 1}, got ${count}`);
  }

  // ONE clock reading for the whole run: two readings could straddle a
  // millisecond boundary and the ids would no longer be tied.
  const milliseconds = Date.now();
  return Array.from({ length: count }, (_, ordinal) => mintTiedId(milliseconds, ordinal));
}

function mintTiedId(milliseconds: number, ordinal: number): string {
  const bytes = new Uint8Array(UUID_BYTES);
  randomFillSync(bytes);

  // Big-endian 48-bit millisecond timestamp, exactly as `uuidv7()` writes it.
  let remaining = milliseconds;
  for (let index = UUID_V7_TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }

  // Version 7 in the high nibble of octet 6, and the ordinal across the 12 bits
  // of `rand_a`. Placing it HERE rather than in the tail is what makes the order
  // deterministic: `rand_a` is the most significant field after the timestamp,
  // so it decides the comparison before any random byte is reached.
  bytes[6] = 0x70 | ((ordinal >>> 8) & 0x0f);
  bytes[7] = ordinal & 0xff;
  // RFC 9562 variant `10` in the top two bits of octet 8; the rest stays random.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
