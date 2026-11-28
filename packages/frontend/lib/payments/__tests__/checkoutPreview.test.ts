import { isLocalCheckoutPreview } from '../checkoutPreview';
let mockEnabled = false;
jest.mock('@/config', () => ({
  get MENTION_PLUS_UI_PREVIEW() {
    return mockEnabled;
  },
}));
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
afterEach(() => {
  mockEnabled = false;
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
  else Reflect.deleteProperty(window, 'location');
});
it('never enables development checkout without explicit opt-in', () => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hostname: 'localhost' },
  });
  expect(isLocalCheckoutPreview()).toBe(false);
});
it.each(['localhost', '127.0.0.1', '[::1]'])('accepts opted-in loopback %s only', (hostname) => {
  mockEnabled = true;
  Object.defineProperty(window, 'location', { configurable: true, value: { hostname } });
  expect(isLocalCheckoutPreview()).toBe(true);
});
it.each(['mention.earth', 'localhost.example', ''])('refuses nonloopback %s', (hostname) => {
  mockEnabled = true;
  Object.defineProperty(window, 'location', { configurable: true, value: { hostname } });
  expect(isLocalCheckoutPreview()).toBe(false);
});
