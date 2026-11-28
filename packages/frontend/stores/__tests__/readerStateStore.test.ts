// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import {
  currentReaderEpoch,
  MAX_READER_ENTRIES,
  patchPostTranslation,
  resetReaderState,
  setReaderFlag,
  useReaderStateStore,
} from '../readerStateStore';

const posts = () => useReaderStateStore.getState().posts;

beforeEach(() => {
  resetReaderState();
});

it('keeps the most recent entries and evicts the oldest past the cap', () => {
  for (let i = 0; i <= MAX_READER_ENTRIES; i += 1) {
    patchPostTranslation(String(i), () => ({ selectedTag: 'en' }));
  }
  // Touching an old entry makes it the newest, so the next one out is `1`.
  patchPostTranslation('0', () => ({ selectedTag: 'fr' }));

  expect(posts().size).toBe(MAX_READER_ENTRIES);
  expect(posts().get('0')?.translation?.selectedTag).toBe('fr');
  expect(posts().has('1')).toBe(false);
});

it('forgets everything on a viewer switch and drops writes started before it', () => {
  const epoch = currentReaderEpoch();
  patchPostTranslation('post-1', () => ({ selectedTag: 'en' }), epoch);
  setReaderFlag('notification-group:a', true);

  resetReaderState();
  // A translation the previous viewer asked for lands after the switch.
  patchPostTranslation('post-1', () => ({ selectedTag: 'en' }), epoch);

  expect(posts().size).toBe(0);
  expect(useReaderStateStore.getState().flags.size).toBe(0);
});
