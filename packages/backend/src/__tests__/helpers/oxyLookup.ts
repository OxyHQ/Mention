// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * `users.lookupMany` for a test that scripts `users.getMany`.
 *
 * The SDK sorts every requested id into found, missing (the server answered
 * without it) or failed (the chunk could not be asked), and never rejects for a
 * chunk failure. A double that only scripts the users it returns therefore
 * gets: every other id is `missing`; and a double that rejects is a chunk that
 * failed, which makes every id `failed`.
 */
export function lookupManyOf<User extends { id?: unknown }>(
  getMany: (ids: string[]) => Promise<User[]> | User[],
) {
  return async (ids: string[]) => {
    const unique = [...new Set(ids)];
    try {
      const found = await getMany(unique);
      const returned = new Set(found.map((user) => String(user.id)));
      return {
        found,
        missing: unique.filter((id) => !returned.has(id)),
        failed: [] as string[],
        error: undefined as unknown,
      };
    } catch (error) {
      return { found: [] as User[], missing: [] as string[], failed: unique, error };
    }
  };
}
