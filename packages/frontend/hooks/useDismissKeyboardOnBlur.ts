import { useCallback } from 'react';
import { Keyboard } from 'react-native';
import { useFocusEffect } from 'expo-router';

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
  useFocusEffect(
    useCallback(() => () => Keyboard.dismiss(), []),
  );
}
