import { Platform } from 'react-native';

/** Toggle the 'dark' class on document.documentElement for web. No-op on native. */
export function applyDarkClass(resolved: 'light' | 'dark') {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }
}
