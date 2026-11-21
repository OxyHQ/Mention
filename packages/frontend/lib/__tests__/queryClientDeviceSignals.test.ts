import { environment } from '@oxy.so/bloom-data';
import { focusManager, onlineManager } from '@tanstack/react-query';
import '../queryClient';

/**
 * React Query's device signals come from bloom-data's `environment`, the one
 * owner of both (the Oxy SDK feeds it on a device, the browser on the web):
 * `lib/queryClient` follows it, so Mention adds no listener of its own.
 */

afterEach(() => {
  environment.setOnline(true);
  environment.setFocused(true);
});

it('follows the environment going offline and back', () => {
  environment.setOnline(false);
  expect(onlineManager.isOnline()).toBe(false);
  environment.setOnline(true);
  expect(onlineManager.isOnline()).toBe(true);
});

it('follows the app leaving the front and coming back', () => {
  environment.setFocused(false);
  expect(focusManager.isFocused()).toBe(false);
  environment.setFocused(true);
  expect(focusManager.isFocused()).toBe(true);
});
