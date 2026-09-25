import React from 'react';
import { Keyboard } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Leaving Search by a result or a tab pushed the next screen with the keyboard
 * still up (#1126, item 15). The keyboard closes when the screen BLURS — not
 * when it gains focus, where it would fight Search's own autofocus.
 */

let mockFocusCleanup: (() => void) | undefined;

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    // Focus on mount, blur on the cleanup the effect hands back — which is what
    // the test drives explicitly.
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      useEffect(() => {
        mockFocusCleanup = effect() ?? undefined;
      }, [effect]);
    },
  };
});

import { useDismissKeyboardOnBlur } from '../useDismissKeyboardOnBlur';

function Screen() {
  useDismissKeyboardOnBlur();
  return null;
}

describe('useDismissKeyboardOnBlur', () => {
  it('leaves the keyboard alone on focus and dismisses it on blur', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    mockFocusCleanup = undefined;

    act(() => {
      TestRenderer.create(<Screen />);
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(mockFocusCleanup).toBeInstanceOf(Function);

    act(() => {
      mockFocusCleanup?.();
    });
    expect(dismiss).toHaveBeenCalledTimes(1);

    dismiss.mockRestore();
  });
});
