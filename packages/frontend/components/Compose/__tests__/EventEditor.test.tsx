import React from 'react';
import { Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
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
jest.mock('@oxy.so/bloom/dialog', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Dialog: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
      mockDialogProps.push(props);
      return <View testID="bloomDialog">{props.children}</View>;
    },
    useDialogControl: () => ({ open: jest.fn(), close: jest.fn() }),
  };
});

/**
 * Bloom's pickers own their popup; the editor's contract is only the value it
 * hands them and what it does with the value they report, so they are stubs
 * that expose their props.
 */
jest.mock('@oxy.so/bloom/date-picker', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    DatePicker: (props: Record<string, unknown>) => <View {...props} />,
    TimeField: (props: Record<string, unknown>) => <View {...props} />,
  };
});

jest.mock('@oxy.so/bloom/field', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Field: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});
jest.mock('@oxy.so/bloom/text-field', () => {
  const { TextInput } = jest.requireActual<typeof import('react-native')>('react-native');
  return { TextFieldInput: (props: Record<string, unknown>) => <TextInput {...props} /> };
});
jest.mock('@oxy.so/bloom/textarea', () => {
  const { TextInput } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Textarea: (props: Record<string, unknown>) => <TextInput multiline {...props} /> };
});

jest.mock('@oxy.so/bloom/theme', () => ({
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
  const findPicker = (tree: TestRenderer.ReactTestRenderer, testID: string) => {
    const node = tree.root.findAll((n) => n.props.testID === testID && typeof n.type !== 'string')[0];
    if (!node) throw new Error(`${testID} not rendered`);
    return node;
  };

  it('hands the picker the local day and keeps the event time when a new day is applied', () => {
    const onDateChange = jest.fn();
    // 18:45 local — the picker hands back midnight, so the merge is what
    // preserves the time the user already chose.
    const original = new Date(2026, 4, 3, 18, 45, 30);
    const tree = renderEditor(original.toISOString(), onDateChange);

    const picker = findPicker(tree, 'eventEditorDatePicker');
    const shown = picker.props.value as Date;
    expect([shown.getFullYear(), shown.getMonth(), shown.getDate(), shown.getHours(), shown.getMinutes()])
      .toEqual([2026, 4, 3, 0, 0]);

    act(() => {
      picker.props.onChange(new Date(2026, 6, 19));
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

    act(() => tree.unmount());
  });

  it('shows the time as 24h HH:mm and keeps the day when a new time is committed', () => {
    const onDateChange = jest.fn();
    const tree = renderEditor(new Date(2026, 4, 3, 8, 5).toISOString(), onDateChange);

    const field = findPicker(tree, 'eventEditorTimeField');
    expect(field.props.value).toBe('08:05');

    act(() => {
      field.props.onChange('21:30');
    });
    expect(onDateChange).toHaveBeenCalledTimes(1);
    const merged = new Date(onDateChange.mock.calls[0][0]);
    expect([merged.getFullYear(), merged.getMonth(), merged.getDate(), merged.getHours(), merged.getMinutes()])
      .toEqual([2026, 4, 3, 21, 30]);

    // Emptying the field is not a time; the event keeps the one it had.
    act(() => {
      field.props.onChange(null);
    });
    expect(onDateChange).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
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
