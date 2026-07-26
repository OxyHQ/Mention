import {
  displayTextToStorageText,
  mergeMentionData,
  reconcileMentionData,
  reconcileMentionTextValue,
  storageTextToDisplayText,
  type MentionData,
} from '../mentions';

const alice: MentionData = {
  userId: 'alice-id',
  username: 'alice',
  displayName: 'Alice',
};
const bob: MentionData = {
  userId: 'bob-id',
  username: 'bob@example.social',
  displayName: 'Bob',
};

describe('composer mention state', () => {
  it('removes metadata when its final placeholder is deleted', () => {
    expect(
      reconcileMentionTextValue({
        text: 'hello',
        mentions: [alice],
      }),
    ).toEqual({ text: 'hello', mentions: [] });
  });

  it('removes replaced metadata without authorizing the replacement text', () => {
    expect(
      reconcileMentionData(['hello @mallory [mention:unknown]'], [alice]),
    ).toEqual([]);
  });

  it('retains one metadata entry while any rendition still contains it', () => {
    expect(
      reconcileMentionTextValue(
        { text: 'primary without it', mentions: [alice, bob] },
        ['translated [mention:alice-id]'],
      ).mentions,
    ).toEqual([alice]);
  });

  it('deduplicates metadata and enriches an unresolved draft entry', () => {
    expect(
      mergeMentionData(
        [{ userId: 'alice-id', username: '', displayName: '' }],
        [alice],
      ),
    ).toEqual([alice]);
  });

  it('round-trips known local and federated handles without partial matches', () => {
    const display = 'Hi @alice and @bob@example.social.';
    const stored = displayTextToStorageText(display, [alice, bob]);
    expect(stored).toBe(
      'Hi [mention:alice-id] and [mention:bob-id].',
    );
    expect(storageTextToDisplayText(stored, [alice, bob])).toBe(display);
    expect(displayTextToStorageText('@alice2 @alice@example.social', [alice])).toBe(
      '@alice2 @alice@example.social',
    );
  });

  it('does not turn an unselected bare handle into a mention', () => {
    expect(displayTextToStorageText('hello @mallory', [alice])).toBe(
      'hello @mallory',
    );
  });

  it('preserves unresolved authorized placeholders without inventing a handle', () => {
    expect(
      storageTextToDisplayText('[mention:alice-id]', [
        { userId: 'alice-id', username: '', displayName: '' },
      ]),
    ).toBe('[mention:alice-id]');
  });
});
