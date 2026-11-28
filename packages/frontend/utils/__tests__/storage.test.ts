// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Storage } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn() } }));

const store = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe('Storage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('round-trips a value through JSON', async () => {
    await expect(Storage.set('prefs', { sort: 'top', count: 2 })).resolves.toBe(true);
    expect(store.setItem).toHaveBeenCalledWith('prefs', '{"sort":"top","count":2}');

    store.getItem.mockResolvedValue('{"sort":"top","count":2}');
    await expect(Storage.get('prefs')).resolves.toEqual({ sort: 'top', count: 2 });
  });

  it('reads a missing key as null', async () => {
    store.getItem.mockResolvedValue(null);
    await expect(Storage.get('absent')).resolves.toBeNull();
  });

  it('reads an unparseable value as null instead of throwing', async () => {
    store.getItem.mockResolvedValue('{not json');
    await expect(Storage.get('corrupt')).resolves.toBeNull();
  });

  it('reports a failed write or removal as false', async () => {
    store.setItem.mockRejectedValue(new Error('quota'));
    store.removeItem.mockRejectedValue(new Error('io'));
    await expect(Storage.set('k', 1)).resolves.toBe(false);
    await expect(Storage.remove('k')).resolves.toBe(false);
  });

  it('removes a key', async () => {
    store.removeItem.mockResolvedValue(undefined);
    await expect(Storage.remove('k')).resolves.toBe(true);
    expect(store.removeItem).toHaveBeenCalledWith('k');
  });
});
