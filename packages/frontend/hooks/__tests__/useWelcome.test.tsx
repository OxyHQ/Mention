import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { authenticatedClient } from '@/utils/api';
import { useCompleteWelcome } from '../useWelcome';

jest.mock('@/utils/api', () => ({
  authenticatedClient: { post: jest.fn() },
  isNotFoundError: () => false,
}));

let complete: ReturnType<typeof useCompleteWelcome> | undefined;
function Probe() {
  complete = useCompleteWelcome();
  return null;
}

async function render() {
  await act(async () => {
    TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

describe('useCompleteWelcome', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    queryClient.clear();
    jest.clearAllMocks();
  });

  it('records completion once on the server', async () => {
    (authenticatedClient.post as jest.Mock).mockResolvedValue({ data: {} });
    await render();
    await act(async () => {
      await complete?.mutateAsync();
    });
    expect(authenticatedClient.post).toHaveBeenCalledTimes(1);
    expect(authenticatedClient.post).toHaveBeenCalledWith('/profile/settings/welcome');
  });

  it('never traps the person in the flow when the write fails', async () => {
    (authenticatedClient.post as jest.Mock).mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => {
      await expect(complete?.mutateAsync()).rejects.toThrow('offline');
    });
    expect(complete?.isError).toBe(true);
  });
});
