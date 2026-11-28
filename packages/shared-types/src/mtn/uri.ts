// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * The stable identifier of a Mention post: `mtn://<oxyUserId>/app.mention.feed.post/<postId>`.
 *
 * Threadgates and postgates are keyed by it (`post_uri`, unique), so the format
 * is frozen: it outlived the signed-record chain it was first minted for.
 */
const MENTION_POST_COLLECTION = 'app.mention.feed.post' as const;

export function createPostUri(oxyUserId: string, postId: string): string {
  return `mtn://${oxyUserId}/${MENTION_POST_COLLECTION}/${postId}`;
}
