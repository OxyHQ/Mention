import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import {
  ProfileGridList,
  type ProfileGridEntry,
} from '../ProfileGridList';

const mockFlashListRender = jest.fn();

jest.mock('@shopify/flash-list', () => {
  const ReactModule = jest.requireActual<typeof React>('react');
  return {
    FlashList: ReactModule.forwardRef(
      (props: Record<string, unknown>, _ref: unknown) => {
        mockFlashListRender(props);
        return null;
      },
    ),
  };
});

describe('ProfileGridList scroll ownership', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses one scroll-owning FlashList with a full-span sticky tab row', () => {
    const data: ProfileGridEntry[] = Array.from(
      { length: 500 },
      (_, index) => ({
        postId: `post-${index}`,
        mediaIndex: 0,
      }),
    );
    let renderer: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProfileGridList
          data={data}
          renderCell={(item) => <Text>{item.postId}</Text>}
          ownsScroll
          listHeaderComponent={<Text>summary</Text>}
          listStickyHeaderComponent={<Text>tabs</Text>}
        />,
      );
    });

    const props = mockFlashListRender.mock.calls.at(-1)?.[0] as {
      data: { kind: string }[];
      numColumns: number;
      stickyHeaderIndices?: number[];
      overrideItemLayout: (
        layout: { span?: number },
        item: { kind: string },
      ) => void;
      drawDistance: number;
    };
    expect(props.data).toHaveLength(501);
    expect(props.data[0]).toEqual(
      expect.objectContaining({ kind: 'auxiliary' }),
    );
    expect(props.numColumns).toBe(3);
    expect(props.stickyHeaderIndices).toEqual([0]);
    expect(props.drawDistance).toBeGreaterThan(0);

    const stickyLayout: { span?: number } = {};
    props.overrideItemLayout(stickyLayout, props.data[0]);
    expect(stickyLayout.span).toBe(3);

    const cellLayout: { span?: number } = {};
    props.overrideItemLayout(cellLayout, props.data[1]);
    expect(cellLayout.span).toBeUndefined();

    act(() => {
      renderer!.unmount();
    });
  });
});
