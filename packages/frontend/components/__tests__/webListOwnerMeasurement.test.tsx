import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import Feed from '../Feed/Feed.web';
import { NotificationsList } from '../NotificationsList.web';

let mockOwner: { current: object } | null = null;
const mockRows = [
  { kind: 'post', item: { id: 'post-1' } },
  { kind: 'recommendation', id: 'card-1' },
];
const mockNodes: any[] = [];
const mockObservers: any[] = [];
const makeVirtualizer = () => ({
  measureElement: jest.fn(),
  options: { scrollMargin: 0 },
  getVirtualItems: () =>
    mockRows.map((_, index) => ({ key: index, index, start: index * 140, size: 140 })),
  getTotalSize: () => 280,
});
const mockDocument = makeVirtualizer();
const mockPanel = makeVirtualizer();
const mockTracker = { current: { setVisible: jest.fn(), setHidden: jest.fn() } };
jest.mock('@oxy.so/bloom/app-shell/hooks', () => ({ usePanelScrollContainer: () => mockOwner }));
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  useScreenViewport: () => null,
}));
jest.mock('@oxy.so/bloom/scroll', () => ({
  useScrollRestoration: () => ({ restorePending: false }),
}));
jest.mock('@/hooks/useOwnerVirtualizer.web', () => ({
  useOwnerVirtualizer: () => (mockOwner ? mockPanel : mockDocument),
}));
jest.mock('@/hooks/useRevealOwnNewPost', () => ({ useRevealOwnNewPost: () => {} }));
jest.mock('../Feed/useScrollMarginOrigin', () => ({ useScrollMarginOrigin: () => 0 }));
jest.mock('@/lib/webTelemetry', () => ({ recordBootMilestone: () => {} }));
jest.mock('@/utils/feedUtils', () => ({ getItemKey: (item: any) => item.id }));
jest.mock('../Feed/feedRows', () => ({
  feedRowKey: (row: any) => row.item?.id ?? row.id,
  renderFeedRow: () => null,
}));
jest.mock('../Feed/useFeedCore', () => ({
  FeedErrorBoundary: ({ children }: any) => children,
  areFeedPropsEqual: () => false,
  useFeedCore: (props: any) => ({
    props,
    theme: { colors: { border: 'gray' } },
    feedRows: mockRows,
    feedState: { hasMore: false, feedScrollKey: 'following' },
    impressionTracker: mockTracker,
  }),
}));
jest.mock('../notifications/NotificationSkeleton', () => ({ NotificationSkeleton: () => null }));
jest.mock('../common/LoadMoreSentinel', () => ({ LoadMoreSentinel: () => null }));

beforeEach(() => {
  mockOwner = null;
  mockNodes.length = 0;
  mockObservers.length = 0;
  jest.clearAllMocks();
  global.IntersectionObserver = class {
    observe = jest.fn();
    disconnect = jest.fn();
    constructor() {
      mockObservers.push(this);
    }
  } as any;
});

function createNodeMock(element: any) {
  const attributes: Record<string, string> = {};
  const node = {
    setAttribute: (key: string, value: string) => {
      attributes[key] = value;
    },
    getAttribute: (key: string) => attributes[key],
    querySelectorAll: () => mockNodes.filter((n) => n.getAttribute('data-post-uri')),
  };
  if (element.props['data-index'] !== undefined) mockNodes.push(node);
  return node;
}

it.each(['feed', 'notifications'])(
  'remeasures retained %s rows when the scroll owner changes',
  (kind) => {
    const render = () =>
      kind === 'feed' ? (
        <Feed type="following" />
      ) : (
        <NotificationsList
          items={mockRows.map((_, i) => ({ key: String(i) })) as any}
          renderRow={() => <span />}
          header={null}
          emptyState={<span />}
          tabKey="all"
          refreshing={false}
          onRefresh={() => {}}
        />
      );
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(render(), { createNodeMock });
    });
    expect(mockDocument.measureElement.mock.calls.filter(([node]) => node)).toHaveLength(2);
    const firstObserver = mockObservers.at(-1);
    if (kind === 'feed') expect(firstObserver.observe).toHaveBeenCalledWith(mockNodes[0]);
    mockOwner = { current: {} };
    act(() => {
      tree?.update(render());
    });
    if (kind === 'feed') expect(firstObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(mockPanel.measureElement.mock.calls.filter(([node]) => node)).toHaveLength(2);
    if (kind === 'feed') {
      const observer = mockObservers.at(-1);
      expect(observer.observe).toHaveBeenCalledWith(
        mockNodes.find((n) => n.getAttribute('data-post-uri') === 'post-1'),
      );
      expect(observer.observe).not.toHaveBeenCalledWith(
        mockNodes.find((n) => !n.getAttribute('data-post-uri')),
      );
    }
    mockPanel.measureElement.mockClear();
    act(() => {
      tree?.update(render());
    });
    expect(mockPanel.measureElement).not.toHaveBeenCalled();
    mockOwner = null;
    mockDocument.measureElement.mockClear();
    act(() => {
      tree?.update(render());
    });
    expect(mockDocument.measureElement.mock.calls.filter(([node]) => node)).toHaveLength(2);
    act(() => {
      tree?.unmount();
    });
  },
);
