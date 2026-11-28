// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Resolving `@mention` placeholders in a post body to the handles they stand for. */
import type { PostUser } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { normalizeMentionIds } from '../../../utils/textProcessing';
import { isFallbackUserSummary, resolveUserSummaries } from './userSummaries';

/**
 * The text a reader actually sees: mention placeholders (`[mention:<id>]`)
 * replaced with the mentioned user's canonical handle. Runs on the RESOLVED
 * body and on every inline variant, so a language switch never exposes a raw
 * placeholder.
 */
export async function resolveMentionText(
  text: string,
  postMentions: readonly string[],
  mentionCache: Map<string, PostUser>,
): Promise<string> {
  if (postMentions.length === 0 || !text.includes('[mention:')) {
    return text;
  }
  return replaceMentionPlaceholders(text, postMentions, mentionCache);
}

export async function replaceMentionPlaceholders(
  text: string,
  mentions: readonly string[],
  mentionCache: Map<string, PostUser>,
): Promise<string> {
  if (!text || !Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }

  // Normalize the current post's declared mention IDs via the shared coercion
  // (the SAME parsing the federation Note builder uses). The per-request cache is
  // intentionally shared across a hydration batch, so replacement must be scoped
  // to this per-post allowlist rather than every cached user.
  const declaredMentionIds = new Set<string>(normalizeMentionIds(mentions));

  // Collect declared mention placeholders present in the text but not yet in
  // the per-request cache. Only placeholders that actually appear are worth
  // resolving.
  const uncachedIds: string[] = [];
  for (const mentionId of declaredMentionIds) {
    if (text.includes(`[mention:${mentionId}]`) && !mentionCache.has(mentionId)) {
      uncachedIds.push(mentionId);
    }
  }

  // Resolve the uncached ids through the shared user-summary resolver: ONE
  // batched Redis read + ONE bulk service-token Oxy fetch for the misses, and
  // it writes the resolved summaries back to the Redis cache. A user who is
  // both a post author and a mention is already warm from `buildUserMap`, so
  // this never re-fetches them. Ids that only resolve to the degraded fallback
  // summary (empty handle, i.e. the lookup failed) are treated as unresolved
  // and left as the original placeholder.
  if (uncachedIds.length > 0) {
    const resolved = await resolveUserSummaries(uncachedIds);
    for (const mentionId of uncachedIds) {
      const value = resolved.get(mentionId);
      // Keep an unresolved result for this request too, so another post or
      // language variant cannot repeat the failed lookup. The shared cache
      // still stores only resolved identities; a later request can retry.
      if (value) mentionCache.set(mentionId, value.user);
    }
  }

  // Single-pass replacement: build the placeholder→replacement map for only
  // this post's declared mention IDs, then run ONE regex over the text. An
  // undeclared or unresolved mention is left as its original placeholder.
  const replacements = new Map<string, string>();
  for (const mentionId of declaredMentionIds) {
    const mentionUser = mentionCache.get(mentionId);
    if (mentionUser && !isFallbackUserSummary(mentionUser)) {
      // Canonical handle (`username@domain` for federated) owns both the label
      // fallback and the link target, so they can never diverge.
      const handle = getNormalizedUserHandle(mentionUser);
      if (!handle) continue;
      // A mention with no display name renders as `@handle` — never `@undefined`.
      const mentionLabel = mentionUser.name?.displayName?.trim() || handle;
      replacements.set(mentionId, `[@${mentionLabel}](${handle})`);
    }
  }

  return text.replace(/\[mention:([^\]]+)\]/g, (placeholder, mentionId: string) => {
    return replacements.get(mentionId) ?? placeholder;
  });
}
