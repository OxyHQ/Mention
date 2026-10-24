import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component },
}));
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  useScreenScroll: () => ({
    onScroll: undefined,
    contentInsets: { top: 0, bottom: 0 },
    scrollY: { value: 0 },
  }),
}));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));

const mockListProps: Record<string, unknown>[] = [];

jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const FlashList = React_.forwardRef<unknown, { children?: React.ReactNode }>((props, ref) => {
    mockListProps.push(props as Record<string, unknown>);
    React_.useImperativeHandle(ref, () => ({ scrollToOffset: () => undefined }));
    return React_.createElement(View, null, props.children);
  });
  FlashList.displayName = 'MockFlashList';
  return { __esModule: true, FlashList };
});

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#1d9bf0', background: '#fff' } }),
}));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));

// The mocks above must be installed first.
import { NotificationsList } from '../NotificationsList.native';

describe('the notifications list’s surface and refresh', () => {
  function render(items: unknown[]) {
    mockListProps.length = 0;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <NotificationsList
          items={items as never[]}
          renderRow={() => <Text>row</Text>}
          header={null}
          emptyState={<Text>empty</Text>}
          tabKey="all"
          refreshing={false}
          onRefresh={() => undefined}
        />,
      );
    });
    const props = mockListProps.at(-1)!;
    act(() => renderer.unmount());
    return props;
  }

  it('paints no fill of its own, so the panel fill shows through like every other tab', () => {
    const props = render([]);
    expect(JSON.stringify(props.style ?? {})).not.toMatch(/backgroundColor/);
    expect(JSON.stringify(props.contentContainerStyle ?? {})).not.toMatch(/backgroundColor/);
  });

  it('grows an empty list to the viewport and keeps the refresh control on it', () => {
    const props = render([]);
    expect(props.contentContainerStyle).toMatchObject({ flexGrow: 1 });
    expect(props.refreshControl).toBeTruthy();
  });

  it('leaves a populated list to size to its rows', () => {
    const props = render([{ kind: 'header', key: 'h', title: 'Today' }]);
    expect(props.contentContainerStyle).not.toHaveProperty('flexGrow');
  });
});
