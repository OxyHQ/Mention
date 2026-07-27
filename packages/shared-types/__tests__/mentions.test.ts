import { describe, expect, it } from 'bun:test';
import {
  extractMentionIds,
  mentionTextsFromContent,
  normalizeMentionIds,
  reconcileMentionIds,
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
