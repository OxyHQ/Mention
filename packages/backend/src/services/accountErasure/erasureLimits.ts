/**
 * The batch sizes the account erasure works in (OxyHQ/Mention#1169).
 *
 * A module of their own so a test can shrink them (`vi.mock`) and exercise every
 * chunked path with a dozen rows instead of thousands. Seeding past the real
 * sizes made `accountErasure.test.ts` insert and delete two thousand rows, which
 * took half a second alone and more than the five-second test budget on a
 * loaded CI runner (OxyHQ/Mention#1178).
 */

/** Posts one batch takes. Bounds the IN lists, the transaction and the closure memory. */
export const ERASURE_POST_BATCH = 100;

/** Past this many boosts in a batch's closure, boosts are deleted in chunks first. */
export const ERASURE_BOOST_CHUNK = 1_000;

/** Rows one DELETE statement takes. Bounds lock time and WAL per statement. */
export const ERASURE_DELETE_BATCH = 1_000;
