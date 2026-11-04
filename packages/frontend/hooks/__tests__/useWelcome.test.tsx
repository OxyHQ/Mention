import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import { authenticatedClient } from '@/utils/api';
import { useCompleteWelcome, useWelcomeStatus } from '../useWelcome';

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: jest.fn() }));
jest.mock('@/utils/api', () => ({ authenticatedClient: { get: jest.fn(), post: jest.fn() } }));

let status: { needsWelcome: boolean } | undefined;
let complete: ReturnType<typeof useCompleteWelcome> | undefined;
function Probe() {
  status = useWelcomeStatus();
  complete = useCompleteWelcome();
  return null;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function render() {
  await act(async () => {
    TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
}

describe('useWelcome', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    (useAuth as jest.Mock).mockReturnValue({ canUsePrivateApi: true, user: { id: 'viewer-a' } });
  });
  afterEach(() => {
    queryClient.clear();
    jest.clearAllMocks();
  });

  it('needs the flow only when the server says it is unfinished, until it is completed', async () => {
    (authenticatedClient.get as jest.Mock).mockResolvedValue({
      data: { welcomeCompletedAt: null },
    });
    (authenticatedClient.post as jest.Mock).mockResolvedValue({
      data: { welcomeCompletedAt: '2026-11-04T00:00:00.000Z' },
    });
    await render();
    expect(status?.needsWelcome).toBe(true);

    await act(async () => {
      await complete?.mutateAsync();
    });
    await settle();
    expect(authenticatedClient.post).toHaveBeenCalledWith('/profile/settings/welcome');
    expect(status?.needsWelcome).toBe(false);
  });

  it('never sends a finished account or one served by a server without the field', async () => {
    (authenticatedClient.get as jest.Mock).mockResolvedValue({
      data: { welcomeCompletedAt: '2026-01-01T00:00:00.000Z' },
    });
    await render();
    expect(status?.needsWelcome).toBe(false);

    queryClient.clear();
    (authenticatedClient.get as jest.Mock).mockResolvedValue({ data: {} });
    await render();
    expect(status?.needsWelcome).toBe(false);
  });

  it('lets a failed write go for this session', async () => {
    (authenticatedClient.get as jest.Mock).mockResolvedValue({
      data: { welcomeCompletedAt: null },
    });
    (authenticatedClient.post as jest.Mock).mockRejectedValue(new Error('offline'));
    await render();
    expect(status?.needsWelcome).toBe(true);
    await act(async () => {
      await complete?.mutateAsync().catch(() => undefined);
    });
    await settle();
    expect(status?.needsWelcome).toBe(false);
  });
});
