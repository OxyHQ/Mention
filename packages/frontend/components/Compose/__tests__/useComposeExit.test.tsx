import TestRenderer, { act } from 'react-test-renderer';

import { useComposeExit, type ComposeExit, type ComposePresentation } from '../useComposeExit';

/**
 * Where the composer goes once it is done, for each of its two routes.
 *
 * OxyHQ/Mention#1140: a published composer was left where the reader could land
 * on it again, still holding the post it had just sent. Leaving WITHOUT
 * publishing (the ✕) keeps the composer reachable on purpose — that one is a
 * draft — so the two exits are pinned side by side.
 */

const mockBack = jest.fn();
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenBack: () => mockBack }));

const mockSelectTab = jest.fn();
const mockLeaveTab = jest.fn();
jest.mock('@oxy.so/bloom/tab-pager', () => ({
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
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => jest.clearAllMocks());

describe('useComposeExit after a publish', () => {
  it('leaves a pushed composer through the app Back (a reply, a quote, an edit)', () => {
    mountExit('pushed').leaveAfterPublish();

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('leaves the composer tab for Home and takes it out of the tabs history', () => {
    mountExit('tab').leaveAfterPublish();

    expect(mockLeaveTab).toHaveBeenCalledWith('write', 'index');
    expect(mockSelectTab).not.toHaveBeenCalled();
  });
});

describe('useComposeExit without publishing (the ✕ keeps the draft)', () => {
  it('switches the tab to Home, leaving the composer and its draft in place', () => {
    mountExit('tab').dismiss();

    expect(mockSelectTab).toHaveBeenCalledWith('index');
    expect(mockLeaveTab).not.toHaveBeenCalled();
  });

  it('pops a pushed composer', () => {
    mountExit('pushed').dismiss();

    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
