import type { ReactElement } from 'react';

const mockLoadFixtures = jest.fn();
const mockFixtureScreen = () => null;
jest.mock('@/components/payments/CheckoutPlaygroundScreen', () => {
  mockLoadFixtures();
  return { __esModule: true, default: mockFixtureScreen };
});
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));

const initialDevelopment = __DEV__;
afterEach(() => {
  Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: initialDevelopment });
});

function loadRoute(development: boolean): ReactElement<{ children?: string }> {
  Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: development });
  let result: ReactElement<{ children?: string }> | undefined;
  jest.isolateModules(() => {
    const Route = require('@/app/(app)/checkout-playground').default;
    result = Route();
  });
  if (!result) throw new Error('Checkout playground route did not return a view');
  return result;
}

it('does not load fixture code or assets in a production build', () => {
  mockLoadFixtures.mockClear();
  const view = loadRoute(false);
  expect(mockLoadFixtures).not.toHaveBeenCalled();
  expect(view.type).toBe('Text');
  expect(view.props.children).toBe('Not available');
});

it('loads the development fixture screen behind the build-time gate', () => {
  mockLoadFixtures.mockClear();
  const view = loadRoute(true);
  expect(mockLoadFixtures).toHaveBeenCalledTimes(1);
  expect(view.type).toBe(mockFixtureScreen);
});
