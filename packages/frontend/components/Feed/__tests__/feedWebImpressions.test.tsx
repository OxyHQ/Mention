import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import Feed from '../Feed.web';

const mockRows = [
  { kind: 'post', item: { id: 'post-1' } },
  { kind: 'recommendation', id: 'card-1' },
];
const mockTracker = { current: { setVisible: jest.fn(), setHidden: jest.fn() } };
jest.mock('@oxy.so/bloom/app-shell/hooks', () => ({ usePanelScrollContainer: () => null }));
jest.mock('@oxy.so/bloom/list', () => ({
  VirtualList: (props: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => React.ReactElement | null;
  }) => <>{props.data.map((item, index) => props.renderItem({ item, index }))}</>,
}));
jest.mock('@oxy.so/bloom/scroll', () => ({
  useScrollRestoration: () => ({ restorePending: false }),
}));
jest.mock('@/hooks/useRevealOwnNewPost', () => ({ useRevealOwnNewPost: () => {} }));
jest.mock('@/lib/webTelemetry', () => ({ recordBootMilestone: () => {} }));
jest.mock('@/utils/feedUtils', () => ({ getItemKey: (item: { id: string }) => item.id }));
jest.mock('../feedRows', () => ({
  feedRowKey: (row: { id?: string; item?: { id: string } }) => row.item?.id ?? row.id,
  renderFeedRow: () => null,
}));
jest.mock('../useFeedCore', () => ({
  FeedErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
  areFeedPropsEqual: () => false,
  useFeedCore: (props: object) => ({
    props,
    theme: { colors: { border: 'gray' } },
    feedRows: mockRows,
    feedState: { hasMore: false, feedScrollKey: 'following' },
    impressionTracker: mockTracker,
  }),
}));

it('tracks impressions for post rows only and closes them when a row unmounts', () => {
  const observed: { getAttribute: (name: string) => string | null }[] = [];
  let report: (entries: object[]) => void = () => {};
  global.IntersectionObserver = class {
    constructor(callback: (entries: object[]) => void) {
      report = callback;
    }
    observe = (node: (typeof observed)[number]) => observed.push(node);
    unobserve = jest.fn();
  } as unknown as typeof IntersectionObserver;

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Feed type="following" />, {
      createNodeMock: (element) => ({
        getAttribute: (name: string) => (element.props as Record<string, string>)[name] ?? null,
      }),
    });
  });
  expect(observed.map((node) => node.getAttribute('data-post-uri'))).toEqual(['post-1']);

  report([{ target: observed[0], isIntersecting: true, intersectionRatio: 0.6 }]);
  expect(mockTracker.current.setVisible).toHaveBeenCalledWith('post-1');

  act(() => renderer.unmount());
  expect(mockTracker.current.setHidden).toHaveBeenCalledWith('post-1');
});
