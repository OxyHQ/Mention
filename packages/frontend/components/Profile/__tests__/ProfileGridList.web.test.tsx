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

it('windows the grid by rows of three cells', () => {
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
      />,
    );
  });

  const rows = mockVirtualList.mock.lastCall?.[0].data as ProfileGridEntry[][];
  expect(rows.map((row) => row.length)).toEqual([3, 3, 1]);
  expect(renderer.root.findAllByType('span')).toHaveLength(7);
  act(() => renderer.unmount());
});
