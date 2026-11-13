import TestRenderer, { act } from 'react-test-renderer';
import { useMentionColorViewer } from '../useMentionColorViewer';

const mockMe = jest.fn();
let mockAuth = {
  user: { id: 'a', username: 'ada' },
  canUsePrivateApi: true,
  activeSessionId: 'session-a',
};
let mockQuery: { data?: unknown; isError: boolean } = { isError: false };
let mockOptions: any;
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ ...mockAuth, oxyServices: { users: { me: mockMe } } }),
  useOxy: () => mockAuth,
}));
jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => {
    mockOptions = options;
    return mockQuery;
  },
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  FREE_COLOR_NAMES: ['blue'],
  HANDLE_COLOR_NAMES: ['oxy'],
  PREMIUM_COLOR_NAMES: ['mono'],
}));
let viewer: ReturnType<typeof useMentionColorViewer>;
let renders = 0;
function Probe() {
  renders += 1;
  viewer = useMentionColorViewer();
  return null;
}

describe('Mention capability read isolation', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  beforeEach(() => {
    jest.useFakeTimers();
    renders = 0;
    mockAuth = {
      user: { id: 'a', username: 'ada' },
      canUsePrivateApi: true,
      activeSessionId: 'session-a',
    };
    mockQuery = { isError: false };
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });
  it('keys private reads by account and session, excludes persisted capability cache, and checks response ownership', async () => {
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(mockOptions.queryKey).toEqual([
      'viewer',
      'a',
      'mention-personalization',
      'session-a',
      true,
    ]);
    expect(mockOptions.gcTime).toBe(0);
    mockMe.mockResolvedValue({ id: 'b' });
    await expect(mockOptions.queryFn()).rejects.toThrow('subject changed');
    expect(mockMe).toHaveBeenCalledWith({ cache: false });
    mockQuery = {
      isError: false,
      data: { id: 'a', personalization: { mentionMono: { allowed: true, expiresAt: null } } },
    };
    mockAuth = {
      user: { id: 'b', username: 'bea' },
      activeSessionId: 'session-b',
      canUsePrivateApi: true,
    };
    act(() => renderer.update(<Probe />));
    expect(mockOptions.queryKey).toEqual([
      'viewer',
      'b',
      'mention-personalization',
      'session-b',
      true,
    ]);
    expect(viewer.mentionMono).toBe(false);
  });
  it('drops granted mono at expiry and on cancellation/error/sign-out', () => {
    mockQuery = {
      isError: false,
      data: {
        id: 'a',
        personalization: {
          mentionMono: { allowed: true, expiresAt: new Date(Date.now() + 1000).toISOString() },
        },
      },
    };
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    expect(viewer.mentionMono).toBe(true);
    act(() => jest.advanceTimersByTime(1000));
    expect(viewer.mentionMono).toBe(false);
    mockQuery = {
      isError: false,
      data: { id: 'a', personalization: { mentionMono: { allowed: false, expiresAt: null } } },
    };
    act(() => renderer.update(<Probe />));
    expect(viewer.mentionMono).toBe(false);
    mockQuery = {
      isError: true,
      data: { id: 'a', personalization: { mentionMono: { allowed: true, expiresAt: null } } },
    };
    act(() => renderer.update(<Probe />));
    expect(viewer.mentionMono).toBe(false);
    mockAuth.canUsePrivateApi = false;
    act(() => renderer.update(<Probe />));
    expect(mockOptions.enabled).toBe(false);
    expect(viewer.mentionMono).toBe(false);
  });

  it('does not render or schedule a timer for a grant without an expiry', () => {
    mockQuery = {
      isError: false,
      data: { id: 'a', personalization: { mentionMono: { allowed: true, expiresAt: null } } },
    };
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    const initialRenders = renders;
    expect(jest.getTimerCount()).toBe(0);
    act(() => jest.advanceTimersByTime(60_000));
    expect(renders).toBe(initialRenders);
    expect(viewer.mentionMono).toBe(true);
  });

  it('schedules long expiries safely and cancels a replaced grant', () => {
    const longDelay = 2_147_483_647 + 1_000;
    mockQuery = {
      isError: false,
      data: {
        id: 'a',
        personalization: {
          mentionMono: { allowed: true, expiresAt: new Date(Date.now() + longDelay).toISOString() },
        },
      },
    };
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    const initialRenders = renders;
    act(() => jest.advanceTimersByTime(longDelay - 1));
    expect(renders).toBe(initialRenders);
    expect(viewer.mentionMono).toBe(true);
    act(() => jest.advanceTimersByTime(1));
    expect(viewer.mentionMono).toBe(false);

    mockQuery = {
      isError: false,
      data: {
        id: 'a',
        personalization: {
          mentionMono: { allowed: true, expiresAt: new Date(Date.now() + 1_000).toISOString() },
        },
      },
    };
    act(() => renderer.update(<Probe />));
    expect(jest.getTimerCount()).toBe(1);
    mockAuth.canUsePrivateApi = false;
    act(() => renderer.update(<Probe />));
    expect(jest.getTimerCount()).toBe(0);
    expect(viewer.mentionMono).toBe(false);
  });
});
