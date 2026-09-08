/**
 * The shapes an Oxy id has ever taken, and the one predicate that knows them.
 *
 * Oxy has minted exactly two: 24-char hex (Mongo ObjectId) before oxy-api's
 * Postgres cutover on 2026-07-31, and uuid **v7** since. Both are live — the
 * cutover carried existing ids over verbatim — so anything that has to
 * RECOGNISE an Oxy id must accept both.
 *
 * It lives here because three call sites across two packages ask the question,
 * and the failure mode of asking it separately is silent: a gate written as
 * `/^[a-f0-9]{24}$/` keeps compiling, keeps passing its tests, and simply
 * answers `false` for every account created after the cutover. That is what it
 * did — in Mention's notification surfaces, where it excluded those accounts
 * from the batch profile prewarm AND from the per-row cache read, so their
 * avatars and names never resolved; and in the platform purge script, whose
 * response validator rejected a perfectly good `nextCursor` as malformed.
 *
 * The uuid arm deliberately does NOT pin the version nibble. Pinning it is
 * exactly how the rule went stale the first time, and a version number is not
 * what makes an id resolvable — the lookup either finds the row or it does not.
 *
 * NOT for deciding whether a `MediaItem.id` is an Oxy file id. That question has
 * a self-describing alternative (an `http(s)` URL) and is answered by negating
 * it, so it needs no id pattern at all and cannot go stale.
 */
const OXY_ID_RE =
  /^(?:[a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** True when `value` has the shape of an Oxy id (account, post, file, cursor). */
export function isOxyId(value: string): boolean {
  return OXY_ID_RE.test(value);
}
