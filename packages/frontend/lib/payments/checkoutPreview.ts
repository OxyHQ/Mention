import { MENTION_PLUS_UI_PREVIEW } from '@/config';
/** Explicit development opt-in is compiled out in production; a loopback host is also mandatory. */
export function isLocalCheckoutPreview(): boolean {
  return (
    MENTION_PLUS_UI_PREVIEW &&
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location?.hostname ?? '')
  );
}
