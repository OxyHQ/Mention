import { toast } from '@oxy.so/bloom/toast';
import { shareUrl } from '@oxy.so/bloom/hooks';
import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('shareLink');

interface ShareLinkOptions {
  /** Human-readable title for the share sheet. */
  title: string;
  /** The canonical URL to share. */
  url: string;
  /** Optional longer message body (defaults to `title`). */
  message?: string;
  /** Toast text shown when the link is copied to the clipboard instead of shared. */
  copiedToast: string;
  /** Toast text shown if neither sharing nor copying was possible. */
  errorToast: string;
}

/**
 * Share a deep link through Bloom's `shareUrl` (system sheet, Web Share or
 * clipboard) and say what happened: a toast when it was copied or failed,
 * silence when shared or dismissed. The one share path every screen uses.
 */
export async function shareLink({
  title,
  url,
  message,
  copiedToast,
  errorToast,
}: ShareLinkOptions): Promise<void> {
  const body = message ?? title;
  const outcome = await shareUrl({ title, url, message: body, copyText: `${body}\n\n${url}` });
  if (outcome === 'copied') {
    toast(copiedToast, { type: 'success' });
  } else if (outcome === 'failed') {
    logger.warn('Failed to share link', { url });
    toast(errorToast, { type: 'error' });
  }
}
