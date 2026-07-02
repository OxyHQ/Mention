/**
 * Legacy CustomFeed → composable definition mapping.
 *
 * The pre-Phase-3 CustomFeed stored a fixed filter shape
 * (`memberOxyUserIds`/`keywords`/`language`/`includeReplies`/`includeBoosts`/
 * `includeMedia`, with the owner implicitly excluded from keyword-only feeds).
 * This pure function translates that shape into a {@link StoredFeedDefinition}
 * over the module registry, reproducing the legacy timeline query.
 *
 * It is the SINGLE mapping used by both the one-shot migration
 * (`scripts/backfillCustomFeedDefinitions.ts`, which persists the result) and the
 * request-time fallback in `customFeedDefinition.ts` (for feeds not yet backfilled).
 */

import type { StoredFeedDefinition } from '../../../models/CustomFeed';
import type { ModuleRef } from '../engine/types';

/** The legacy fields the mapping reads off a CustomFeed document. */
export interface LegacyCustomFeedShape {
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  keywords?: string[];
  language?: string;
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
}

/**
 * Build the composable definition for a legacy custom feed.
 *
 * - `memberOxyUserIds` → `accounts` source (`{ authorIds }`).
 * - `keywords` → `keywords` source (matched against content text + hashtags).
 * - `language` → `languagePreference` filter (`{ languages: [language] }`).
 * - `includeReplies === false` → `noReplies` filter.
 * - `includeBoosts === false` → `noBoosts` filter.
 * - `includeMedia === false` → `textOnly` filter (the closest catalog module to
 *   the legacy "hide media" behaviour; it additionally drops polls).
 * - owner not in members → `muteBlock` filter excluding the owner (reproduces the
 *   legacy implicit owner-exclusion on keyword-only feeds).
 *
 * Always `chronological` (legacy feeds had no ranking). A feed with neither
 * members nor keywords maps to an empty-source definition — it renders empty,
 * exactly like the legacy criteria-less feed.
 */
export function legacyCustomFeedToDefinition(feed: LegacyCustomFeedShape): StoredFeedDefinition {
  const memberIds = Array.from(new Set((feed.memberOxyUserIds ?? []).filter((id) => typeof id === 'string' && id.length > 0)));
  const keywords = (feed.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0);

  const sources: ModuleRef[] = [];
  if (memberIds.length > 0) {
    sources.push({ module: 'accounts', enabled: true, params: { authorIds: memberIds } });
  }
  if (keywords.length > 0) {
    sources.push({ module: 'keywords', enabled: true, params: { keywords } });
  }

  const filters: ModuleRef[] = [];
  if (feed.language) {
    filters.push({ module: 'languagePreference', enabled: true, params: { languages: [feed.language] } });
  }
  if (feed.includeReplies === false) {
    filters.push({ module: 'noReplies', enabled: true });
  }
  if (feed.includeBoosts === false) {
    filters.push({ module: 'noBoosts', enabled: true });
  }
  if (feed.includeMedia === false) {
    filters.push({ module: 'textOnly', enabled: true });
  }
  if (feed.ownerOxyUserId && !memberIds.includes(feed.ownerOxyUserId)) {
    filters.push({ module: 'muteBlock', enabled: true, params: { excludedIds: [feed.ownerOxyUserId] } });
  }

  return { mode: 'chronological', sources, signals: [], filters };
}
