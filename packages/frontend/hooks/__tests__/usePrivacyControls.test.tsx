import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import {
  setPrivacyListMembership,
  usePrivacyControls,
  type PrivacySets,
} from '../usePrivacyControls';

const mockBlocked = jest.fn();
const mockRestricted = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

const seen: PrivacySets[] = [];
function Probe() {
  seen.push(usePrivacyControls());
  return null;
}

function signIn(viewerId: string) {
  (useAuth as jest.Mock).mockReturnValue({
    oxyServices: { privacy: { blocked: mockBlocked, restricted: mockRestricted } },
    canUsePrivateApi: true,
    user: { id: viewerId },
  });
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
    );
  });
  // Let the read settle and its answer render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return renderer;
}

describe('usePrivacyControls', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => queryClient.clear());

  it('reads the lists once for every mounted feed, and again only for another viewer', async () => {
    mockBlocked.mockResolvedValue([{ blockedId: 'blocked-by-a' }]);
    mockRestricted.mockResolvedValue([]);
    signIn('viewer-a');
    const first = await render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    const second = await render(<Probe />);

    expect(mockBlocked).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)?.blockedSet.has('blocked-by-a')).toBe(true);
    for (const renderer of [first, second]) act(() => renderer.unmount());

    mockBlocked.mockResolvedValue([{ blockedId: 'blocked-by-b' }]);
    signIn('viewer-b');
    seen.length = 0;
    const third = await render(<Probe />);

    expect(mockBlocked).toHaveBeenCalledTimes(2);
    expect(seen.some((sets) => sets.blockedSet.has('blocked-by-a'))).toBe(false);
    expect(seen.at(-1)?.blockedSet.has('blocked-by-b')).toBe(true);
    act(() => third.unmount());
  });

  it('holds an empty answer when the read fails, and applies a block written meanwhile', async () => {
    mockBlocked.mockRejectedValue(new Error('unauthorized'));
    mockRestricted.mockResolvedValue([]);
    signIn('viewer-c');
    seen.length = 0;
    const renderer = await render(<Probe />);
    expect(seen.at(-1)?.blockedSet.size).toBe(0);

    await act(async () => {
      setPrivacyListMembership('viewer-c', 'blocked', 'just-blocked', true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen.at(-1)?.blockedSet.has('just-blocked')).toBe(true);

    await act(async () => {
      setPrivacyListMembership('viewer-c', 'blocked', 'just-blocked', false);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen.at(-1)?.blockedSet.has('just-blocked')).toBe(false);
    act(() => renderer.unmount());
  });

  it('reads every shape of an Oxy list entry, and records a restriction for a viewer it holds', async () => {
    mockBlocked.mockResolvedValue([{ blockedId: { _id: 'b-object' } }, { _id: 'b-own' }, {}]);
    mockRestricted.mockResolvedValue([{ restrictedId: 'r-id' }, { userId: 'r-user' }]);
    signIn('viewer-d');
    seen.length = 0;
    const renderer = await render(<Probe />);
    expect([...(seen.at(-1)?.blockedSet ?? [])]).toEqual(['b-object', 'b-own']);
    expect([...(seen.at(-1)?.restrictedSet ?? [])]).toEqual(['r-id', 'r-user']);

    // A viewer whose lists were never read has nothing to update.
    setPrivacyListMembership('viewer-unread', 'restricted', 'someone', true);
    expect(queryClient.getQueryData(['viewer', 'viewer-unread', 'privacy-lists'])).toBeUndefined();

    await act(async () => {
      setPrivacyListMembership('viewer-d', 'restricted', 'r-new', true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(seen.at(-1)?.restrictedSet.has('r-new')).toBe(true);
    act(() => renderer.unmount());
  });
});
