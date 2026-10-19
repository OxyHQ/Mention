import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import { usePrivacyControls, type PrivacySets } from '../usePrivacyControls';

const mockBlocked = jest.fn();
const mockRestricted = jest.fn();

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: jest.fn() }));

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
});
