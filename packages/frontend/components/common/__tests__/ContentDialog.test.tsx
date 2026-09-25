import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ContentDialogHost, showContentDialog } from '../ContentDialog';

const mockDialog = jest.fn();
const mockControl = { open: jest.fn(), close: jest.fn() };

jest.mock('@oxy.so/bloom/dialog', () => ({
  useDialogControl: () => mockControl,
  Dialog: (props: { children?: React.ReactNode }) => {
    mockDialog(props);
    return <>{props.children}</>;
  },
}));

function lastDialogProps() {
  return mockDialog.mock.calls.at(-1)?.[0];
}

describe('ContentDialogHost', () => {
  let tree!: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    act(() => {
      tree = TestRenderer.create(<ContentDialogHost />);
    });
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  // Edit Profile opened in this dialog with its title flush against the sheet's
  // edge and no close control: Bloom's declarative `title` sits inside the
  // content padding, which this host zeroes for its list panels. A titled panel
  // now gets Bloom's navigation header, which insets the title and draws close.
  it('puts a titled panel in the navigation header, which carries the close control', () => {
    act(() => {
      showContentDialog({
        label: 'Edit Profile',
        title: 'Edit Profile',
        render: () => <Text>form</Text>,
      });
    });

    const props = lastDialogProps();
    expect(mockControl.open).toHaveBeenCalledTimes(1);
    expect(props.header).toEqual({ title: 'Edit Profile', largeTitle: false });
    expect(props.header.showClose).not.toBe(false);
    expect(props.title).toBeUndefined();
    expect(props.contentPadding).toBe(0);
    expect(tree.root.findByType(Text).props.children).toBe('form');
  });

  it('leaves an untitled panel without a header; it draws its own', () => {
    act(() => {
      showContentDialog({ label: 'Likes', render: () => <Text>likes</Text> });
    });

    const props = lastDialogProps();
    expect(props.header).toBeUndefined();
    expect(props.label).toBe('Likes');
  });
});
