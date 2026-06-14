import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { show as toast } from '@oxyhq/bloom/toast';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('shareLink');

interface ShareLinkOptions {
  /** Human-readable title for the share sheet. */
  title: string;
  /** The canonical URL to share. */
  url: string;
  /** Optional longer message body (defaults to `title`). */
  message?: string;
  /** Toast text shown on web when the link is copied to the clipboard. */
  copiedToast: string;
  /** Toast text shown if sharing fails. */
  errorToast: string;
}

/**
 * Share a deep link in a platform-correct way:
 * - native: RN `Share.share`
 * - web: `navigator.share` when available, otherwise copy to clipboard + toast
 *
 * Mirrors the app's existing share behavior (`usePostShare`, agora room share).
 */
export async function shareLink({
  title,
  url,
  message,
  copiedToast,
  errorToast,
}: ShareLinkOptions): Promise<void> {
  const body = message ?? title;
  try {
    if (Platform.OS === 'web') {
      const nav = typeof navigator !== 'undefined' ? navigator : undefined;
      if (nav?.share) {
        await nav.share({ title, text: body, url });
      } else if (nav?.clipboard) {
        await nav.clipboard.writeText(`${body}\n\n${url}`);
        toast(copiedToast, { type: 'success' });
      } else {
        await Clipboard.setStringAsync(`${body}\n\n${url}`);
        toast(copiedToast, { type: 'success' });
      }
    } else {
      await Share.share({ message: `${body}\n\n${url}`, url, title });
    }
  } catch (error) {
    // A user cancelling the native share sheet rejects the promise; treat
    // cancellations as benign and only surface genuine failures.
    if (error instanceof Error && /cancel|dismiss/i.test(error.message)) {
      return;
    }
    logger.warn('Failed to share link', { error });
    toast(errorToast, { type: 'error' });
  }
}
