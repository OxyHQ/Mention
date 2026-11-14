import {
  currentReaderEpoch,
  MAX_READER_ENTRIES,
  patchPostTranslation,
  resetReaderState,
  setReaderFlag,
  useReaderStateStore,
} from '../readerStateStore';

const translations = () => useReaderStateStore.getState().translations;

beforeEach(() => {
  resetReaderState();
});

it('keeps the most recent entries and evicts the oldest past the cap', () => {
  for (let i = 0; i <= MAX_READER_ENTRIES; i += 1) {
    patchPostTranslation(String(i), () => ({ selectedTag: 'en' }));
  }
  // Touching an old entry makes it the newest, so the next one out is `1`.
  patchPostTranslation('0', () => ({ selectedTag: 'fr' }));

  expect(translations().size).toBe(MAX_READER_ENTRIES);
  expect(translations().get('0')?.selectedTag).toBe('fr');
  expect(translations().has('1')).toBe(false);
});

it('forgets everything on a viewer switch and drops writes started before it', () => {
  const epoch = currentReaderEpoch();
  patchPostTranslation('post-1', () => ({ selectedTag: 'en' }), epoch);
  setReaderFlag('notification-group:a', true);

  resetReaderState();
  // A translation the previous viewer asked for lands after the switch.
  patchPostTranslation('post-1', () => ({ selectedTag: 'en' }), epoch);

  expect(translations().size).toBe(0);
  expect(useReaderStateStore.getState().flags.size).toBe(0);
});
