import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ScheduleSheet, { parseDateTime } from '../ScheduleSheet';

const mockToast = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { border: '#333', card: '#fff', error: '#dc2626' } }),
}));

jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

/** Bloom's pickers own their popups; the sheet's contract is the values it
 *  hands them and what it does with what they report. */
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
jest.mock('@oxy.so/bloom/card', () => {
  const { Pressable } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Card: (props: Record<string, unknown>) => <Pressable {...props} /> };
});

const byTestID = (tree: TestRenderer.ReactTestRenderer, testID: string) => {
  const node = tree.root.findAll((n) => n.props.testID === testID && typeof n.type !== 'string')[0];
  if (!node) throw new Error(`${testID} not rendered`);
  return node;
};

const renderSheet = (onSelect: (date: Date) => void, scheduledAt: Date | null = null) => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ScheduleSheet
        scheduledAt={scheduledAt}
        options={[]}
        onSelect={onSelect}
        onClear={() => {}}
        onClose={() => {}}
        formatLabel={(date) => date.toISOString()}
      />,
    );
  });
  if (!tree) throw new Error('ScheduleSheet failed to render');
  return tree;
};

const pressApply = (tree: TestRenderer.ReactTestRenderer) => {
  const apply = tree.root
    .findAll((n) => typeof n.props.onPress === 'function' && typeof n.type !== 'string')
    .find((n) => JSON.stringify(n.findAll((c) => typeof c.props.children === 'string').map((c) => c.props.children)).includes('Schedule'));
  if (!apply) throw new Error('Apply button not rendered');
  act(() => apply.props.onPress());
};

describe('parseDateTime', () => {
  it('merges a local day and a 24h time into one local timestamp', () => {
    const parsed = parseDateTime(new Date(2030, 0, 2), '07:05');
    expect(parsed && [parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes()])
      .toEqual([2030, 0, 2, 7, 5]);
  });

  it('needs both halves', () => {
    expect(parseDateTime(null, '07:05')).toBeNull();
    expect(parseDateTime(new Date(2030, 0, 2), null)).toBeNull();
  });
});

describe('ScheduleSheet custom time', () => {
  beforeEach(() => mockToast.mockClear());

  it('seeds the pickers with the scheduled time in local day and HH:mm', () => {
    const scheduledAt = new Date(2030, 5, 7, 9, 45);
    const tree = renderSheet(jest.fn(), scheduledAt);
    const day = byTestID(tree, 'scheduleSheetDatePicker').props.value as Date;
    expect([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()]).toEqual([2030, 5, 7, 0]);
    expect(byTestID(tree, 'scheduleSheetTimeField').props.value).toBe('09:45');
    // Past days cannot be picked.
    const minDate = byTestID(tree, 'scheduleSheetDatePicker').props.minDate as Date;
    expect(minDate.getHours()).toBe(0);
    act(() => tree.unmount());
  });

  it('schedules the picked future day and time', () => {
    const onSelect = jest.fn();
    const tree = renderSheet(onSelect);
    act(() => byTestID(tree, 'scheduleSheetDatePicker').props.onChange(new Date(2099, 2, 4)));
    act(() => byTestID(tree, 'scheduleSheetTimeField').props.onChange('18:30'));
    pressApply(tree);
    expect(mockToast).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    const picked = onSelect.mock.calls[0][0] as Date;
    expect([picked.getFullYear(), picked.getMonth(), picked.getDate(), picked.getHours(), picked.getMinutes()])
      .toEqual([2099, 2, 4, 18, 30]);
    act(() => tree.unmount());
  });

  it('rejects a time in the past', () => {
    const onSelect = jest.fn();
    const tree = renderSheet(onSelect);
    act(() => byTestID(tree, 'scheduleSheetDatePicker').props.onChange(new Date(2000, 0, 1)));
    pressApply(tree);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('Pick a future time', { type: 'error' });
    act(() => tree.unmount());
  });

  it('rejects an emptied time', () => {
    const onSelect = jest.fn();
    const tree = renderSheet(onSelect);
    act(() => byTestID(tree, 'scheduleSheetTimeField').props.onChange(null));
    pressApply(tree);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith('Enter a valid date and time', { type: 'error' });
    act(() => tree.unmount());
  });
});
