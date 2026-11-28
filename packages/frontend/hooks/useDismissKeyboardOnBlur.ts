// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { useCallback } from 'react';
import { Keyboard } from 'react-native';
import { useFocusEffect } from '@/lib/navigation/router';

/**
 * Close the soft keyboard when this screen stops being the focused one.
 *
 * A screen that owns an input — Search autofocuses its box — would otherwise
 * push the next screen with the keyboard still up and covering half of it:
 * tapping a result or a tab does not blur the field, because the list keeps
 * taps (`keyboardShouldPersistTaps`) so a result can be opened in one tap, and
 * the tab bar never touches it. The screen underneath keeps its focused
 * `TextInput`, and Android keeps the keyboard for it.
 *
 * Tied to the screen's BLUR rather than to the navigation handlers, so every way
 * of leaving — a result, a tab, Back, a deep link — is covered by one line in
 * the screen instead of one per handler.
 */
export function useDismissKeyboardOnBlur(): void {
  useFocusEffect(useCallback(() => () => Keyboard.dismiss(), []));
}
