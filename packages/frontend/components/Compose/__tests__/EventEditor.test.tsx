import React from 'react';
import { Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Calendar } from '@/components/ui/Calendar';
import { EventEditor } from '../EventEditor';

const mockDialogProps: Record<string, unknown>[] = [];

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

/**
 * The Dialog stands in for bloom's, recording what the editor handed it. It is a
 * passthrough so the form below still renders — but a passthrough ONLY: the
 * assertions check the props, and separately that no RN `Modal` is anywhere in
 * the tree, so reintroducing a hand-rolled shell fails rather than merely
 * looking different.
 */
jest.mock('@oxyhq/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Dialog: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      mockDialogProps.push(props);
      return <View testID="bloomDialog">{props.children}</View>;
    },
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

jest.mock('@oxyhq/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/components/ui/Button', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return { IconButton: TouchableOpacity };
});

const noop = () => {};

const renderEditor = (date: string, onDateChange: (next: string) => void) => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <EventEditor
        visible
        name="Launch party"
        date={date}
        location=""
        description=""
        onNameChange={noop}
        onDateChange={onDateChange}
        onLocationChange={noop}
        onDescriptionChange={noop}
        onSave={noop}
        onClose={noop}
      />,
    );
  });
  if (!tree) throw new Error('EventEditor failed to render');
  return tree;
};

describe('EventEditor date field', () => {
  it('keeps the event time when the calendar reports a new day', () => {
    const onDateChange = jest.fn();
    // 18:45 local — the calendar hands back midnight, so the merge is what
    // preserves the time the user already chose.
    const original = new Date(2026, 4, 3, 18, 45, 30);
    const tree = renderEditor(original.toISOString(), onDateChange);

    // The calendar is only mounted once the date field is opened.
    expect(tree.root.findAllByType(Calendar)).toHaveLength(0);
    const dateField = tree.root
      .findAll((node) => node.props.onPress !== undefined)
      .find((node) =>
        node.findAllByType(Text).some((text) => text.props.children === 'Date'),
      );
    if (!dateField) throw new Error('Date field not rendered');
    act(() => {
      dateField.props.onPress();
    });

    const calendar = tree.root.findByType(Calendar);
    act(() => {
      calendar.props.onChange(new Date(2026, 6, 19));
    });

    expect(onDateChange).toHaveBeenCalledTimes(1);
    const merged = new Date(onDateChange.mock.calls[0][0]);
    expect([
      merged.getFullYear(),
      merged.getMonth(),
      merged.getDate(),
      merged.getHours(),
      merged.getMinutes(),
      merged.getSeconds(),
    ]).toEqual([2026, 6, 19, 18, 45, 30]);

    // Picking a day closes the calendar again.
    expect(tree.root.findAllByType(Calendar)).toHaveLength(0);
  });
});

describe('EventEditor surface', () => {
  beforeEach(() => {
    mockDialogProps.length = 0;
  });

  it("renders through bloom's Dialog, with no RN Modal anywhere", () => {
    const tree = renderEditor(new Date(2026, 4, 3, 18, 45).toISOString(), () => {});

    expect(tree.root.findAllByProps({ testID: 'bloomDialog' }).length).toBeGreaterThan(0);
    // The direct guard. A hand-rolled `<Modal>` shell opens its own native
    // window, which sits outside bloom's surface ordering — the layering bug
    // this migration exists to remove — so its absence is asserted, not implied
    // by the Dialog merely also being present.
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);

    act(() => tree.unmount());
  });

  it('gives the Dialog the sheet-to-card placement and its own header, not a hand-built bar', () => {
    const tree = renderEditor(new Date(2026, 4, 3, 18, 45).toISOString(), () => {});

    const props = mockDialogProps.at(-1);
    expect(props?.placement).toEqual({ base: 'bottom', md: 'center' });
    expect(props?.open).toBe(true);
    // An editor is a writing surface, not a confirm box: it must not be left on
    // the centered-card default at phone width.
    expect(props?.maxHeightRatio).toBe(0.92);
    const header = props?.header as { title?: string; right?: unknown } | undefined;
    expect(header?.title).toBe('Create event');
    expect(header?.right).toBeTruthy();

    act(() => tree.unmount());
  });

  it('closes through the Dialog rather than a bespoke affordance', () => {
    const onClose = jest.fn();
    let tree: TestRenderer.ReactTestRenderer | undefined;
    act(() => {
      tree = TestRenderer.create(
        <EventEditor
          visible
          name="Launch party"
          date={new Date(2026, 4, 3, 18, 45).toISOString()}
          location=""
          description=""
          onNameChange={noop}
          onDateChange={noop}
          onLocationChange={noop}
          onDescriptionChange={noop}
          onSave={noop}
          onClose={onClose}
        />,
      );
    });

    const props = mockDialogProps.at(-1);
    act(() => {
      (props?.onClose as () => void)();
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => tree?.unmount());
  });

  it('keeps the draft across an open, close and reopen', () => {
    const onNameChange = jest.fn();
    let tree: TestRenderer.ReactTestRenderer | undefined;

    const render = (visible: boolean) => (
      <EventEditor
        visible={visible}
        name="Launch party"
        date={new Date(2026, 4, 3, 18, 45).toISOString()}
        location="Berlin"
        description="Bring cake"
        onNameChange={onNameChange}
        onDateChange={noop}
        onLocationChange={noop}
        onDescriptionChange={noop}
        onSave={noop}
        onClose={noop}
      />
    );

    act(() => { tree = TestRenderer.create(render(true)); });
    act(() => { tree?.update(render(false)); });
    act(() => { tree?.update(render(true)); });

    // The composer owns every field, so the reopened surface shows what was
    // typed. A migration that moved any of them into local state would show an
    // empty form on the second open — and this is the assertion that catches it.
    if (!tree) throw new Error('EventEditor failed to re-render');
    const values = tree.root
      .findAll((node) => node.props.value !== undefined && node.props.onChangeText !== undefined)
      .map((node) => node.props.value);
    expect(values).toEqual(expect.arrayContaining(['Launch party', 'Berlin', 'Bring cake']));

    act(() => tree?.unmount());
  });
});
