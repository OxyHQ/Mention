import { APP_COLOR_PRESETS } from '@oxy.so/bloom/color-presets';
import { getUserPlaceholderColor } from '../userPlaceholderColor';

it('uses the shared Bloom identity for avatars, including legacy colors', () => {
  expect(getUserPlaceholderColor({ color: 'grove' })).toBe(APP_COLOR_PRESETS.grove.hex);
  expect(getUserPlaceholderColor({ color: 'amber' })).toBe(APP_COLOR_PRESETS.yellow.hex);
  expect(getUserPlaceholderColor({ color: '#ABC' })).toBe('#aabbcc');
  expect(getUserPlaceholderColor({ color: '#123456' })).toBe('#123456');
  expect(getUserPlaceholderColor({ color: 'unknown' })).toBeUndefined();
  expect(getUserPlaceholderColor()).toBeUndefined();
});
