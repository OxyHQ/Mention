import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useComposeExit, type ComposeExit, type ComposePresentation } from '../useComposeExit';
import { pageIndexByName } from '@/components/navigation/tabs';

/**
 * Where the composer goes once it is done, for each of its two routes.
 *
 * OxyHQ/Mention#1140: a published composer was left where the reader could land
 * on it again, still holding the post it had just sent. Leaving WITHOUT
 * publishing (the ✕) keeps the composer reachable on purpose — that one is a
 * draft — so the two exits are pinned side by side.
 */

const mockRouter = {
  canGoBack: jest.fn(() => true),
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};

jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
  useRouter: () => mockRouter,
}));

const mockSelectTab = jest.fn();
const mockLeaveTab = jest.fn();
jest.mock('@/context/TabPagerContext', () => ({
  useTabPager: () => ({ selectTab: mockSelectTab, leaveTab: mockLeaveTab }),
}));

function mountExit(presentation: ComposePresentation): ComposeExit {
  let exit: ComposeExit | null = null;
  const Probe = () => {
    exit = useComposeExit(presentation);
    return null;
  };
  act(() => {
    TestRenderer.create(<Probe />);
  });
  if (!exit) throw new Error('the probe never rendered');
  return exit;
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});

describe('useComposeExit after a publish', () => {
  it('pops a pushed composer (a reply, a quote, an edit)', () => {
    mountExit('pushed').leaveAfterPublish();

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('REPLACES a pushed composer with nothing beneath it, never pushes over it', () => {
    // A cold-start share or deep link: a push would leave the composer — still
    // holding the published post — one Back away.
    mockRouter.canGoBack.mockReturnValue(false);

    mountExit('pushed').leaveAfterPublish();

    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('leaves the composer tab for Home and takes it out of the tabs history', () => {
    mountExit('tab').leaveAfterPublish();

    expect(mockLeaveTab).toHaveBeenCalledWith(pageIndexByName('write'), pageIndexByName('index'));
    expect(mockSelectTab).not.toHaveBeenCalled();
  });
});

describe('useComposeExit without publishing (the ✕ keeps the draft)', () => {
  it('switches the tab to Home, leaving the composer and its draft in place', () => {
    mountExit('tab').dismiss();

    expect(mockSelectTab).toHaveBeenCalledWith(pageIndexByName('index'));
    expect(mockLeaveTab).not.toHaveBeenCalled();
  });

  it('pops a pushed composer', () => {
    mountExit('pushed').dismiss();

    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });
});
