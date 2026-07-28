import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Calendar } from '@/components/ui/Calendar';
import { EventEditor } from '../EventEditor';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

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
