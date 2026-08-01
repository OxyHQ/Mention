/**
 * Trend labelling — turning a detected term into something a reader recognises.
 *
 * A term is a RETRIEVAL key: it has to match the words people typed, so it is
 * lowercase, often a fragment, and sometimes not even the subject (`orioles`
 * for a trade involving a pitcher named Kremer). A LABEL is what the story is —
 * `Kremer Trade` — and it is the only one of the two a reader ever sees. They
 * are different strings on purpose, and conflating them is what makes a
 * trending list read like a log of tokens.
 *
 * Two properties matter more than the labels themselves:
 *
 *  - **Fail-soft.** No key configured, model down, malformed answer, unknown
 *    category — every one of those costs a nicer label and nothing else. The
 *    deterministic fallback always produces something presentable, so a
 *    labelling outage can never empty or break the trending list.
 *  - **Stable.** A term that already carries a label KEEPS it. Re-asking every
 *    30 minutes would rename a live story under a reader mid-scroll, and would
 *    spend the batch's whole labelling budget re-deciding questions that were
 *    already answered.
 */

import { MtnConfig, normalizeTrendCategory } from '@mention/shared-types';
import type { TrendCategory } from '@mention/shared-types';
import { aliaJSON, isAliaEnabled } from '../../utils/alia';
import { logger } from '../../utils/logger';

/** What a trend is shown as. */
export interface TrendLabel {
  /** Human-readable name — the only string a reader sees. */
  displayName: string;
  /** Coarse taxonomy hint, `other` when nothing fits. */
  category: TrendCategory;
}

/** One term plus the evidence a labeller needs to name it. */
export interface TrendLabelRequest {
  term: string;
  /**
   * A few posts that carry the term. The term ALONE is not enough to name a
   * story — `orioles` cannot become `Kremer Trade` without reading what people
   * wrote — so the excerpts are the whole reason this produces better labels
   * than string formatting can.
   */
  excerpts: string[];
}

/** Longest excerpt sent per post. Bounds the prompt; a lede is enough to name a story. */
const MAX_EXCERPT_LENGTH = 240;

/** Longest label accepted back. Anything longer is a sentence, not a name. */
const MAX_DISPLAY_NAME_LENGTH = 48;

/**
 * The deterministic label: the term itself, title-cased, filed under `other`.
 *
 * Used for every term when labelling is unavailable, and for any single term the
 * model declined to name. It is deliberately dull rather than clever — a
 * fabricated category or an invented headline would be a worse failure than a
 * plain one, because nothing downstream could tell it from a real answer.
 */
export function fallbackTrendLabel(term: string): TrendLabel {
  return { displayName: titleCase(term), category: 'other' };
}

/**
 * Whether generated labels are available at all.
 *
 * Exposed so a caller can skip GATHERING the evidence a labeller would need.
 * `labelTrends` already no-ops without a key, but the excerpts are several
 * indexed queries per term, and collecting them to feed a call that will not
 * happen is pure waste on a job that runs every 30 minutes forever.
 */
export function isTrendLabellingAvailable(): boolean {
  return isAliaEnabled();
}

/**
 * Label the given terms, returning one entry per REQUESTED term.
 *
 * Total by construction: a caller can always read a label out of the result, so
 * no call site needs its own fallback branch (and none can forget one). The
 * request list is expected to be pre-filtered to terms that have no label yet
 * and capped by the caller at `MtnConfig.trending.labeling.maxPerBatch`.
 */
export async function labelTrends(
  requests: readonly TrendLabelRequest[],
): Promise<Map<string, TrendLabel>> {
  const labels = new Map<string, TrendLabel>();
  for (const request of requests) {
    labels.set(request.term, fallbackTrendLabel(request.term));
  }

  if (requests.length === 0 || !isAliaEnabled()) return labels;

  try {
    const answer = await aliaJSON<{ trends?: Array<{ term?: string; displayName?: string; category?: string }> }>(
      [
        {
          role: 'system',
          content:
            'You name trending topics for a social network. For each term you are given, ' +
            'return the short human-readable name of the STORY the posts are about — like a ' +
            'headline subject, not a summary. Prefer proper names and events over the raw ' +
            'term. Keep it under 5 words, in the language the posts are written in. ' +
            `Also classify it into exactly one of: ${MtnConfig.trending.labeling.categories.join(', ')}. ` +
            'Return ONLY JSON: {"trends":[{"term":"<the term you were given>",' +
            '"displayName":"<name>","category":"<category>"}]}',
        },
        {
          role: 'user',
          content: JSON.stringify({
            trends: requests.map((request) => ({
              term: request.term,
              posts: request.excerpts.map((excerpt) => excerpt.slice(0, MAX_EXCERPT_LENGTH)),
            })),
          }),
        },
      ],
      { temperature: 0.2 },
    );

    for (const entry of answer.trends ?? []) {
      // Matched back by TERM, never by position: a model that drops, reorders or
      // invents an entry would otherwise attach a label to the wrong trend, and
      // a wrong label is indistinguishable from a right one downstream.
      const term = typeof entry.term === 'string' ? entry.term.trim().toLowerCase() : '';
      if (!term || !labels.has(term)) continue;

      const displayName = sanitizeDisplayName(entry.displayName);
      if (!displayName) continue;

      labels.set(term, { displayName, category: normalizeTrendCategory(entry.category) });
    }
  } catch (error) {
    // Warn, not error: the batch is unaffected and every term already holds its
    // deterministic label. Visible in diagnostics, invisible to the reader.
    logger.warn('[Trending] Labelling failed; using deterministic labels', { error });
  }

  return labels;
}

/** Accept a model-supplied name, or nothing. Never repairs — only rejects. */
function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * Title-case a term for display (`todd blanche` → `Todd Blanche`).
 *
 * Word-by-word and nothing else: no small-word rules, no acronym repair. The
 * input is already lowercase, so `EU` cannot be recovered, and inventing a rule
 * that guesses would be wrong on exactly the terms it was written for.
 */
function titleCase(term: string): string {
  return term
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}
