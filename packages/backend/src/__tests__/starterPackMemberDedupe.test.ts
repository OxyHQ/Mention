/**
 * A starter pack must never store the same account twice.
 *
 * This shipped: pack `6a35840f2160a431714b96d5` held SEVEN entries for FIVE
 * accounts — `69bf1395db3d3cba5d28bc25` twice and `019fc915-…-f5828565e53c`
 * twice — and rendered every duplicate as its own row, with a "7 accounts"
 * count to match. The cause was not one buggy endpoint but a DISAGREEMENT
 * between three: `POST /:id/members` unioned into a `Set`, while `POST /` and
 * `PUT /:id` stored whatever array arrived. Which behaviour a pack got depended
 * on which endpoint its client used.
 *
 * The guard therefore lives on the schema path, and these tests assert the
 * property at that level rather than through any one route — a fourth write
 * path added later inherits it without knowing it exists.
 */

import { dedupeMemberIds } from '../models/StarterPack';

describe('starter pack membership is a set', () => {
  it('drops repeats and keeps the first occurrence in place', () => {
    // Order is load-bearing: the list renders in stored order and the owner
    // chose it, so deduping must not double as a sort. `b` staying between `a`
    // and `c` is the assertion — a Set built from a sorted copy would pass a
    // length check and fail this.
    expect(dedupeMemberIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('collapses the exact production pack to its five real accounts', () => {
    expect(dedupeMemberIds([
      '69bf1395db3d3cba5d28bc25',
      '69bf1395db3d3cba5d28bc25',
      '019fc915-3e50-7216-be11-f5828565e53c',
      '019fc915-3e50-7216-be11-f5828565e53c',
      '6a3583d5f24acd91fb2643b1',
      '6a3583e6f24acd91fb2643b5',
      '6a3583f0f24acd91fb2643b6',
    ])).toEqual([
      '69bf1395db3d3cba5d28bc25',
      '019fc915-3e50-7216-be11-f5828565e53c',
      '6a3583d5f24acd91fb2643b1',
      '6a3583e6f24acd91fb2643b5',
      '6a3583f0f24acd91fb2643b6',
    ]);
  });

  /**
   * The two id shapes in that pack are NOT interchangeable strings to a reader:
   * one is a 24-char Mongo ObjectId hex, the other a UUIDv7. Deduping compares
   * them as opaque strings on purpose — normalising case or format would risk
   * merging two genuinely different accounts, which is far worse than a repeat.
   */
  it('treats ids as opaque, never normalising two distinct ones together', () => {
    expect(dedupeMemberIds(['69BF1395DB3D3CBA5D28BC25', '69bf1395db3d3cba5d28bc25']))
      .toHaveLength(2);
  });

  it('rejects the shapes a client can actually send instead of an id', () => {
    // Not tidy inputs: a real body can carry a null from a failed lookup, a
    // number, or an empty string from a cleared field. Each would otherwise
    // become a member row pointing at nobody.
    expect(dedupeMemberIds(['a', '', null, undefined, 42, {}, 'a'])).toEqual(['a']);
  });

  it('answers with an empty list for a non-array, rather than throwing', () => {
    // `memberOxyUserIds` arrives from `req.body`, so it can be anything at all.
    // A setter that throws would surface as a 500 on an ordinary bad request.
    expect(dedupeMemberIds(undefined)).toEqual([]);
    expect(dedupeMemberIds('69bf1395db3d3cba5d28bc25')).toEqual([]);
    expect(dedupeMemberIds({ 0: 'a' })).toEqual([]);
  });
});
