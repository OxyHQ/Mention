import { type ScreenReselectHandler, useScreenReselectHandler } from '@oxy.so/bloom/screen';

/**
 * What reselecting the enclosing Bloom `Screen` means, declared from the
 * component that renders that Screen: `useScreenReselectHandler` answers only
 * from inside it. Render it as a child of the `<Screen>`.
 */
export function ScreenReselect(handler: ScreenReselectHandler) {
  useScreenReselectHandler(handler);
  return null;
}
