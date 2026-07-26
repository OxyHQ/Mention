import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import useRealtimePosts from '@/hooks/useRealtimePosts';

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockGetAccessToken = jest.fn(() => 'token-a');

let mockAuthState = {
  activeSessionId: 'session-a' as string | null,
  canUsePrivateApi: true,
  user: { id: 'viewer-a' } as { id: string } | null,
  oxyServices: { getAccessToken: mockGetAccessToken },
};

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => mockAuthState,
  useOxy: () => ({ activeSessionId: mockAuthState.activeSessionId }),
}));

jest.mock('@/services/socketService', () => ({
  socketService: {
    connect: (...args: unknown[]) => mockConnect(...args),
    disconnect: (...args: unknown[]) => mockDisconnect(...args),
  },
}));

function Harness({ revision }: { revision: number }) {
  void revision;
  useRealtimePosts();
  return null;
}

describe('useRealtimePosts socket ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccessToken.mockReturnValue('token-a');
    mockAuthState = {
      activeSessionId: 'session-a',
      canUsePrivateApi: true,
      user: { id: 'viewer-a' },
      oxyServices: { getAccessToken: mockGetAccessToken },
    };
  });

  it('disconnects the authenticated socket when the viewer logs out', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness revision={0} />);
    });

    expect(mockConnect).toHaveBeenCalledWith('viewer-a', 'token-a');

    mockAuthState = {
      ...mockAuthState,
      activeSessionId: null,
      canUsePrivateApi: false,
      user: null,
    };
    await act(async () => {
      renderer.update(<Harness revision={1} />);
    });

    expect(mockDisconnect).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });
  });

  it('tears down A before connecting B and releases B on unmount', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness revision={0} />);
    });

    mockGetAccessToken.mockReturnValue('token-b');
    mockAuthState = {
      activeSessionId: 'session-b',
      canUsePrivateApi: true,
      user: { id: 'viewer-b' },
      oxyServices: { getAccessToken: mockGetAccessToken },
    };
    await act(async () => {
      renderer.update(<Harness revision={1} />);
    });

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenNthCalledWith(2, 'viewer-b', 'token-b');
    expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockConnect.mock.invocationCallOrder[1],
    );

    await act(async () => {
      renderer.unmount();
    });
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
  });

  it('does not acquire a socket before the private API token is ready', async () => {
    mockAuthState = {
      ...mockAuthState,
      canUsePrivateApi: false,
    };

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Harness revision={0} />);
    });

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();

    await act(async () => {
      renderer.unmount();
    });
  });
});
