import { useEffect, useRef, useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';

const COMBO_TIMEOUT = 1000; // 1 second to press second key after 'g'

interface KeyboardShortcutsState {
  showHelpModal: boolean;
  setShowHelpModal: (show: boolean) => void;
}

export const SHORTCUTS = [
  { keys: ['n'], description: 'New post' },
  { keys: ['Ctrl', 'n'], description: 'New post' },
  { keys: ['/'], description: 'Search' },
  { keys: ['g', 'h'], description: 'Go home' },
  { keys: ['g', 'n'], description: 'Go to notifications' },
  { keys: ['g', 'e'], description: 'Go to explore' },
  { keys: ['g', 's'], description: 'Go to saved' },
  { keys: ['g', 'p'], description: 'Go to profile' },
  { keys: ['?'], description: 'Show keyboard shortcuts' },
  { keys: ['Escape'], description: 'Close modal' },
] as const;

export function useKeyboardShortcuts(): KeyboardShortcutsState {
  const [showHelpModal, setShowHelpModal] = useState(false);
  const router = useRouter();
  const { user } = useAuth();
  const pendingComboRef = useRef<string | null>(null);
  const comboTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCombo = useCallback(() => {
    pendingComboRef.current = null;
    if (comboTimerRef.current) {
      clearTimeout(comboTimerRef.current);
      comboTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = event.target as HTMLElement;
      const tagName = target?.tagName?.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target?.isContentEditable
      ) {
        // Still allow Escape in inputs
        if (event.key !== 'Escape') return;
      }

      const key = event.key;

      // Handle Escape
      if (key === 'Escape') {
        clearCombo();
        setShowHelpModal(false);
        return;
      }

      // Handle second key of g-combo
      if (pendingComboRef.current === 'g') {
        clearCombo();
        event.preventDefault();
        switch (key) {
          case 'h':
            router.push('/');
            return;
          case 'n':
            router.push('/notifications');
            return;
          case 'e':
            router.push('/explore');
            return;
          case 's':
            router.push('/saved');
            return;
          case 'p':
            if (user?.username) {
              router.push(`/@${user.username}`);
            }
            return;
          default:
            // Invalid combo, fall through
            break;
        }
      }

      // Handle first key presses
      if (key === 'g' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        pendingComboRef.current = 'g';
        comboTimerRef.current = setTimeout(clearCombo, COMBO_TIMEOUT);
        return;
      }

      // Ctrl+n or plain n -> compose
      if (key === 'n' && !event.metaKey && !event.altKey) {
        event.preventDefault();
        router.push('/compose');
        return;
      }

      // / -> search
      if (key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        router.push('/search');
        return;
      }

      // ? -> help modal
      if (key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        setShowHelpModal((prev) => !prev);
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearCombo();
    };
  }, [router, user?.username, clearCombo]);

  return { showHelpModal, setShowHelpModal };
}
