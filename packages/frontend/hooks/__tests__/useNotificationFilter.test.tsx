import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useNotificationFilter } from '../useNotificationFilter';

let mockParams: { filter?: string | string[] } = {};
const mockRouter = {
  setParams: jest.fn((params: typeof mockParams) => {
    mockParams = params;
  }),
};
jest.mock('@/lib/navigation/router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

function mountFilter() {
  const captured: {
    value?: ReturnType<typeof useNotificationFilter>;
    renderer?: ReactTestRenderer;
  } = {};
  function Probe() {
    captured.value = useNotificationFilter();
    return null;
  }
  act(() => {
    captured.renderer = create(<Probe />);
  });
  const { value, renderer } = captured;
  if (!value || !renderer) throw new Error('Expected the notification filter hook to mount');
  return { value, unmount: () => act(() => renderer.unmount()) };
}

beforeEach(() => {
  mockParams = {};
  mockRouter.setParams.mockClear();
});

describe('notification filter route state', () => {
  it('retains the selected filter across unmounting behind a post', () => {
    const first = mountFilter();
    expect(first.value.activeTab).toBe('all');
    act(() => first.value.selectTab('likes'));
    expect(mockRouter.setParams).toHaveBeenCalledWith({ filter: 'likes' });
    first.unmount();
    const returned = mountFilter();
    expect(returned.value.activeTab).toBe('likes');
    act(() => returned.value.selectTab('all'));
    expect(mockRouter.setParams).toHaveBeenLastCalledWith({ filter: undefined });
    returned.unmount();
  });
  it.each(['mentions', 'follows', 'likes', 'posts', 'pokes', 'all'])(
    'reads the valid %s route filter',
    (filter) => {
      mockParams = { filter };
      const mounted = mountFilter();
      expect(mounted.value.activeTab).toBe(filter);
      mounted.unmount();
    },
  );
  it.each([undefined, 'unknown', ['likes', 'posts']])(
    'defaults an invalid or repeated filter to All (%j)',
    (filter) => {
      mockParams = { filter };
      const mounted = mountFilter();
      expect(mounted.value.activeTab).toBe('all');
      mounted.value.selectTab('unknown');
      expect(mockRouter.setParams).not.toHaveBeenCalled();
      mounted.unmount();
    },
  );
});
