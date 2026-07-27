import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  ProfileGridList,
  type ProfileGridEntry,
} from '../ProfileGridList.web';

const mockUseWindowVirtualizer = jest.fn();

jest.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (options: unknown) =>
    mockUseWindowVirtualizer(options),
}));

describe('ProfileGridList web document virtualization', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseWindowVirtualizer.mockReturnValue({
      getVirtualItems: () => [
        { index: 4, key: 'row-4', start: 404, size: 101 },
        { index: 5, key: 'row-5', start: 505, size: 101 },
      ],
      getTotalSize: () => 16_867,
      options: { scrollMargin: 0 },
    });
  });

  it('virtualizes 500 cells as rows against window and mounts only visible rows', () => {
    const data: ProfileGridEntry[] = Array.from(
      { length: 500 },
      (_, index) => ({
        postId: `post-${index}`,
        mediaIndex: 0,
      }),
    );
    const renderCell = jest.fn((item: ProfileGridEntry) => (
      <span>{item.postId}</span>
    ));
    let renderer: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProfileGridList data={data} renderCell={renderCell} />,
      );
    });

    expect(mockUseWindowVirtualizer).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 167,
        overscan: 5,
        scrollMargin: 0,
      }),
    );
    expect(renderCell).toHaveBeenCalledTimes(6);
    expect(renderer!.root.findAllByType('span')).toHaveLength(6);

    act(() => {
      renderer!.unmount();
    });
  });
});
