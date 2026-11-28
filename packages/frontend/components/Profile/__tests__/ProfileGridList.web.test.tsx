import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileGridList, type ProfileGridEntry } from '../ProfileGridList.web';

const mockVirtualList = jest.fn();
jest.mock('@oxy.so/bloom/list', () => ({
  VirtualList: <T,>(props: {
    data: T[];
    renderItem: (info: { item: T; index: number }) => React.ReactElement;
  }) => {
    mockVirtualList(props);
    return <>{props.data.map((item, index) => props.renderItem({ item, index }))}</>;
  },
}));

it.each([
  [undefined, [3, 3, 1]],
  [2, [2, 2, 2, 1]],
])('windows the grid with column override %s', (columns, lengths) => {
  const data: ProfileGridEntry[] = Array.from({ length: 7 }, (_, index) => ({
    postId: `post-${index}`,
    mediaIndex: 0,
  }));
  const renderCell = jest.fn((item: ProfileGridEntry) => <span>{item.postId}</span>);
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ProfileGridList
        restorationKey="viewer-1:profile-1:media"
        data={data}
        renderCell={renderCell}
        layout={columns ? { columns, inset: 12, gap: 12, cellHeight: () => 200 } : undefined}
      />,
    );
  });

  const rows = mockVirtualList.mock.lastCall?.[0].data as ProfileGridEntry[][];
  expect(rows.map((row) => row.length)).toEqual(lengths);
  expect(renderer.root.findAllByType('span')).toHaveLength(7);
  act(() => renderer.unmount());
});
