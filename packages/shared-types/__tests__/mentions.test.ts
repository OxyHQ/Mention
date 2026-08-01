import { describe, expect, it } from 'bun:test';
import {
  extractMentionIds,
  MAX_MENTIONS_PER_POST,
  mentionTextsFromContent,
  normalizeMentionIds,
  reconcileMentionIds,
  reconcileMentionIdsDetailed,
} from '../src/mentions';

describe('canonical mention reconciliation', () => {
  it('extracts distinct placeholders in body order', () => {
    expect(
      extractMentionIds('Hi [mention:b], [mention:a], again [mention:b]'),
    ).toEqual(['b', 'a']);
  });

  it('keeps only authorized ids that still have a real placeholder', () => {
    expect(
      reconcileMentionIds(
        ['Hi [mention:kept]', 'And [mention:second]'],
        ['orphan', 'second', 'kept', 'second'],
      ),
    ).toEqual(['kept', 'second']);
  });

  it('never grants authority to a hand-typed placeholder', () => {
    expect(reconcileMentionIds(['[mention:victim]'], [])).toEqual([]);
    expect(reconcileMentionIds(['[mention:victim]'], ['someone-else'])).toEqual([]);
  });

  it('normalizes historical object ids without preserving empties', () => {
    expect(normalizeMentionIds([' a ', { id: 'b' }, { _id: 'a' }, '', null])).toEqual([
      'a',
      'b',
    ]);
  });

  it('uses every author rendition but ignores machine translations', () => {
    expect(
      mentionTextsFromContent({
        text: 'hydrated convenience text',
        variants: [
          { source: 'author', text: '[mention:primary]' },
          { source: 'author', text: '[mention:secondary]' },
          { source: 'machine', text: '[mention:machine-only]' },
        ],
      }),
    ).toEqual(['[mention:primary]', '[mention:secondary]']);
  });
});

/**
 * Per-post ceiling at the shared write boundary.
 *
 * Every stored mention allowlist — native compose, reply, boost-with-comment, both
 * edit paths, and federated ingest — passes through `reconcileMentionIds`. A post
 * body may be 25,000 characters, which is room for roughly 750 placeholders, so
 * without a ceiling here one post can make hydration resolve 750 user summaries
 * every time it renders.
 */
describe('per-post mention ceiling', () => {
  const body = (count: number): string =>
    Array.from({ length: count }, (_, i) => `[mention:u${i}]`).join(' ');
  const ids = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `u${i}`);

  it('holds the chosen value — moving it must be a deliberate act', () => {
    expect(MAX_MENTIONS_PER_POST).toBe(16);
  });

  it('keeps every mention AT the ceiling', () => {
    const kept = reconcileMentionIds([body(MAX_MENTIONS_PER_POST)], ids(MAX_MENTIONS_PER_POST));

    expect(kept).toEqual(ids(MAX_MENTIONS_PER_POST));
  });

  it('keeps exactly the ceiling one over it, in body order', () => {
    const kept = reconcileMentionIds(
      [body(MAX_MENTIONS_PER_POST + 1)],
      ids(MAX_MENTIONS_PER_POST + 1),
    );

    expect(kept).toEqual(ids(MAX_MENTIONS_PER_POST));
    expect(kept).not.toContain(`u${MAX_MENTIONS_PER_POST}`);
  });

  it('reports the pre-cap total so the server can say it truncated', () => {
    // The capped list alone cannot distinguish a post that legitimately named
    // exactly the ceiling from one that named 700 — both come back the same
    // length. `total` is what makes the drop reportable rather than silent.
    const atCeiling = reconcileMentionIdsDetailed(
      [body(MAX_MENTIONS_PER_POST)],
      ids(MAX_MENTIONS_PER_POST),
    );
    expect(atCeiling.total).toBe(MAX_MENTIONS_PER_POST);
    expect(atCeiling.total).toBe(atCeiling.ids.length);

    const overCeiling = reconcileMentionIdsDetailed([body(700)], ids(700));
    expect(overCeiling.ids).toHaveLength(MAX_MENTIONS_PER_POST);
    expect(overCeiling.total).toBe(700);
  });

  it('counts only AUTHORIZED placeholders towards the ceiling', () => {
    // 700 placeholders in the body, 3 of them actually authorized: the post is not
    // near the ceiling, and nothing is reported as truncated.
    const result = reconcileMentionIdsDetailed([body(700)], ['u0', 'u5', 'u9']);

    expect(result.ids).toEqual(['u0', 'u5', 'u9']);
    expect(result.total).toBe(3);
  });
});
