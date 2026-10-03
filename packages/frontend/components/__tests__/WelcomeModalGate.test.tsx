import React from 'react';
import { Platform } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import WelcomeModalGate from '../WelcomeModalGate';

/**
 * The first-visit welcome modal covers the whole page. On a phone that is the
 * intrusive interstitial search engines rank down — and Google indexes the
 * phone layout — so it is shown only wider than a phone.
 */

let mockNotPhone = true;
jest.mock('@/hooks/useOptimizedMediaQuery', () => ({
  useIsScreenNotMobile: () => mockNotPhone,
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ isAuthenticated: false }) }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined) },
}));
jest.mock('../WelcomeModal', () => ({
  __esModule: true,
  default: (props: { visible: boolean }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="welcome-modal">{String(props.visible)}</Text>;
  },
}));

// Jest cannot run the gate's dynamic `import()`; hand `lazy` the mocked modal.
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  lazy: () => jest.requireMock('../WelcomeModal').default,
}));

function modals(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'welcome-modal');
}

async function renderGate(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<WelcomeModalGate appIsReady />);
  });
  // The gate waits out the splash transition before asking for the modal.
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

describe('WelcomeModalGate', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
  });
  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalOS });
  });

  it('welcomes a first-time visitor on a wide screen', async () => {
    mockNotPhone = true;
    const renderer = await renderGate();
    expect(modals(renderer)).toHaveLength(1);
  });

  it('never covers the page on a phone', async () => {
    mockNotPhone = false;
    const renderer = await renderGate();
    expect(modals(renderer)).toHaveLength(0);
  });
});
