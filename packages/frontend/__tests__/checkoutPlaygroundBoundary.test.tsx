import type { ReactElement } from 'react';
import type * as TestRendererModule from 'react-test-renderer';

const mockLoadFixtures = jest.fn();
const mockFixtureScreen = () => null;
jest.mock('@/components/payments/CheckoutPlaygroundScreen', () => {
  mockLoadFixtures();
  return { __esModule: true, default: mockFixtureScreen };
});
jest.mock('@oxy.so/bloom/typography', () => ({
  ...jest.requireActual('@oxy.so/bloom/typography'),
  Text: 'Text',
}));

const initialDevelopment = __DEV__;
afterEach(() => {
  Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: initialDevelopment });
});

function loadRoute(development: boolean): { view: ReactElement; words: string } {
  Object.defineProperty(globalThis, '__DEV__', { configurable: true, value: development });
  let result: { view: ReactElement; words: string } | undefined;
  jest.isolateModules(() => {
    const Route = require('@/app/(app)/checkout-playground').default;
    const view: ReactElement = Route();
    // The route's words are a language text: it is drawn, with this module
    // registry's React, to read them.
    const TestRenderer = require('react-test-renderer') as typeof TestRendererModule;
    const { BloomThemeProvider } = require('@oxy.so/bloom/theme');
    const React = require('react');
    let words = '';
    if (view.type !== mockFixtureScreen) {
      let tree!: TestRendererModule.ReactTestRenderer;
      TestRenderer.act(() => {
        tree = TestRenderer.create(React.createElement(BloomThemeProvider, { fonts: false }, view));
      });
      words = tree.root
        .findAll((node) => node.type === 'Text')
        .flatMap((node) => node.props.children)
        .filter((child): child is string => typeof child === 'string')
        .join('');
      TestRenderer.act(() => tree.unmount());
    }
    result = { view, words };
  });
  if (!result) throw new Error('Checkout playground route did not return a view');
  return result;
}

it('does not load fixture code or assets in a production build', () => {
  mockLoadFixtures.mockClear();
  const { view, words } = loadRoute(false);
  expect(mockLoadFixtures).not.toHaveBeenCalled();
  expect(view.type).not.toBe(mockFixtureScreen);
  expect(words).toBe('Not available');
});

it('loads the development fixture screen behind the build-time gate', () => {
  mockLoadFixtures.mockClear();
  const { view } = loadRoute(true);
  expect(mockLoadFixtures).toHaveBeenCalledTimes(1);
  expect(view.type).toBe(mockFixtureScreen);
});
