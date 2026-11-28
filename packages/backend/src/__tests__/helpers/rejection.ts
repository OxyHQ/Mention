// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
