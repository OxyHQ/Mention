/**
 * Which rows of one batch present the same name.
 *
 * A row has a retrieval term (the key the feed matches on) and a label (what
 * the reader sees). Labels are derived from the posts behind each term, so two
 * terms can be labelled identically — `chinese` and `jensen huang` both read
 * "Jensen Huang" when most of their posts say the same full name. A reader who
 * sees one name twice cannot tell the rows apart, which means they are the same
 * subject. This module finds those rows; the caller re-measures them as one.
 *
 * Pure. No database, no clock, no randomness.
 */

/** The fields this module needs from a ranked row. */
export interface PresentedNameRow {
  term: string;
  displayName: string;
  volume: number;
}

/**
 * The comparison key for a presented name: case, diacritics and punctuation
 * do not make a different name (`Jensen Huang` and `jensen-huang` are one
 * name to a reader).
 */
export function presentedNameKey(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Groups of terms whose rows present the same name. Only groups of two or more
 * are returned.
 *
 * Each group lists its terms with the highest-volume term first — the
 * representative the merged row is reported under, matching how clusters pick
 * theirs. Ties break on the term so the result is a pure function of the input.
 * Groups come back ordered by their key, so two batches over the same rows
 * agree.
 */
export function groupRowsByPresentedName(rows: readonly PresentedNameRow[]): string[][] {
  const byKey = new Map<string, PresentedNameRow[]>();
  for (const row of rows) {
    const key = presentedNameKey(row.displayName);
    if (!key) continue;
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, group]) => group)
    .filter((group) => group.length > 1)
    .map((group) =>
      [...group]
        .sort((left, right) => right.volume - left.volume || left.term.localeCompare(right.term))
        .map((row) => row.term),
    );
}
