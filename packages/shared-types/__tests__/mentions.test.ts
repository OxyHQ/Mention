import { describe, expect, it } from 'bun:test';
import {
  extractMentionIds,
  MAX_MENTIONS_PER_POST,
  mapMentionTexts,
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
 * A write boundary that DERIVES a mention from a body has to change that body
 * too: the id it stores only renders if a placeholder sits in the text, and
 * `reconcileMentionIds` drops any id that has none. So the renditions that may
 * mention somebody and the renditions that get rewritten have to be the SAME
 * set, and these pin that they are — including for the shapes where the two
 * could plausibly disagree (a machine translation, and the `text` convenience
 * form that only counts when there are no author variants at all).
 */
describe('rewriting the renditions that can mention', () => {
  it('rewrites exactly the renditions `mentionTextsFromContent` reads', () => {
    const content = {
      variants: [
        { source: 'author', text: 'see https://x/@a' },
        { source: 'author', text: 'mira https://x/@a' },
        { source: 'machine', text: 'voir https://x/@a' },
      ],
    };

    expect(mapMentionTexts(content, (text) => text.replace('https://x/@a', '[mention:a]'))).toBe(
      true,
    );
    expect(content.variants.map((v) => v.text)).toEqual([
      'see [mention:a]',
      'mira [mention:a]',
      'voir https://x/@a',
    ]);
  });

  it('falls back to `text` on exactly the bodies that have no author variant', () => {
    const clientShape = { text: 'see https://x/@a' };
    mapMentionTexts(clientShape, () => 'rewritten');
    expect(clientShape.text).toBe('rewritten');

    // An author variant exists, so `text` is the hydration convenience copy and
    // is NOT a rendition anybody can be mentioned from — nor one to write to.
    const storedShape = { text: 'convenience copy', variants: [{ source: 'author', text: 'body' }] };
    mapMentionTexts(storedShape, () => 'rewritten');
    expect(storedShape.text).toBe('convenience copy');
    expect(storedShape.variants[0].text).toBe('rewritten');
  });

  it('reports no change when the transform returns the text it was given', () => {
    const content = { text: 'nothing to do here' };
    expect(mapMentionTexts(content, (text) => text)).toBe(false);
    expect(content.text).toBe('nothing to do here');
  });

  it('is a no-op on a body with no renditions at all', () => {
    expect(mapMentionTexts({ media: [] }, () => 'rewritten')).toBe(false);
    expect(mapMentionTexts(undefined, () => 'rewritten')).toBe(false);
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
