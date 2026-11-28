// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStorage } from '@oxy.so/bloom/storage';
import { logger } from '@oxy.so/core/logger';

const jsonStorage = createStorage('', {
  adapter: AsyncStorage,
  onError: (error, operation, key) =>
    logger.warn(`[Storage] Failed to ${operation} item: ${key}`, { error }),
});

/**
 * Best-effort JSON storage over AsyncStorage (raw keys), from Bloom's
 * `createStorage`. `getStrict` is the one addition: it tells an absent key from
 * every stored JSON value, including `null`, and throws on an unreadable one.
 */
export const Storage = {
  ...jsonStorage,
  async getStrict<T>(key: string): Promise<{ found: false } | { found: true; value: T }> {
    const item = await AsyncStorage.getItem(key);
    return item === null ? { found: false } : { found: true, value: JSON.parse(item) as T };
  },
};
