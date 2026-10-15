/**
 * The reason `work` rejected with; throws if it resolved instead.
 *
 * For `bun test`, in place of `await expect(work).rejects.toSatisfy(predicate)`.
 * bun:test's `rejects.toSatisfy` hands the predicate the promise rather than
 * the rejection reason, so the predicate fails and the rejection surfaces as an
 * unhandled error in whichever test runs next. Awaiting `work` here also runs a
 * lazy query builder (drizzle, postgres.js), which only executes once `then` is
 * called.
 */
export async function rejectionOf(work: PromiseLike<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject, but it resolved');
}
