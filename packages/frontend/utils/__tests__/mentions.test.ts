import {
  areMentionDataEqual,
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

describe('mention metadata registry', () => {
  it('drops an entry with no user id and fills a missing name from the handle', () => {
    expect(
      mergeMentionData([
        { userId: '  ', username: 'ghost', displayName: 'Ghost' },
        { userId: 'carol-id', username: undefined as unknown as string, displayName: '' },
        { userId: 'dave-id', username: 'dave', displayName: '  ' },
      ]),
    ).toEqual([
      { userId: 'carol-id', username: '', displayName: '' },
      { userId: 'dave-id', username: 'dave', displayName: 'dave' },
    ]);
  });

  it('keeps the richer identity when a later entry for the same id is blank', () => {
    expect(
      mergeMentionData([alice], [{ userId: 'alice-id', username: '', displayName: '' }]),
    ).toEqual([alice]);
    expect(
      mergeMentionData(
        [{ userId: 'alice-id', username: '', displayName: '' }],
        [{ userId: 'alice-id', username: 'alice', displayName: '' }],
      ),
    ).toEqual([{ userId: 'alice-id', username: 'alice', displayName: 'alice' }]);
  });

  it('compares registries field by field and in order', () => {
    expect(areMentionDataEqual([alice, bob], [alice, bob])).toBe(true);
    expect(areMentionDataEqual([alice, bob], [bob, alice])).toBe(false);
    expect(areMentionDataEqual([alice], [alice, bob])).toBe(false);
    expect(areMentionDataEqual([alice], [{ ...alice, username: 'alicia' }])).toBe(false);
    expect(areMentionDataEqual([alice], [{ ...alice, displayName: 'Alicia' }])).toBe(false);
  });
});
