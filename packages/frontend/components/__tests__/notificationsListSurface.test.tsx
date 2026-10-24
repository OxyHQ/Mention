import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

const mockListProps: Record<string, unknown>[] = [];

jest.mock('@oxy.so/bloom/list', () => ({
  VirtualList: (props: Record<string, unknown>) => {
    mockListProps.push(props);
    return null;
  },
}));

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
    expect(props.onRefresh).toEqual(expect.any(Function));
  });

  it('leaves a populated list to size to its rows', () => {
    const props = render([{ kind: 'header', key: 'h', title: 'Today' }]);
    expect(props.contentContainerStyle).toBeUndefined();
  });
});
