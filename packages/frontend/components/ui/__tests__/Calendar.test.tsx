import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Calendar } from '../Calendar';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

type Json = ReturnType<TestRenderer.ReactTestRenderer['toJSON']>;
type JsonNode = Exclude<Json, null | string | Json[]>;

const isNode = (value: unknown): value is JsonNode =>
  typeof value === 'object' && value !== null && 'type' in value;

const textOf = (node: JsonNode): string => {
  const children = node.children ?? [];
  return children
    .map((child) => (typeof child === 'string' ? child : isNode(child) ? textOf(child) : ''))
    .join('');
};

const collect = (node: JsonNode, match: (candidate: JsonNode) => boolean): JsonNode[] => {
  const found = match(node) ? [node] : [];
  for (const child of node.children ?? []) {
    if (isNode(child)) found.push(...collect(child, match));
  }
  return found;
};

const renderCalendar = (value: Date, onChange: (date: Date) => void = () => {}) => {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(<Calendar value={value} onChange={onChange} />);
  });
  if (!tree) throw new Error('Calendar failed to render');
  return tree;
};

/**
 * Rebuilds the day grid exactly as it is laid out: six rows of seven slots,
 * `null` where the cell is blank. Asserting the SHAPE (not just the set of day
 * numbers) is what catches an off-by-one in the leading-blank offset — every
 * month whose 1st falls on a Sunday hides that bug.
 */
const dayGrid = (tree: TestRenderer.ReactTestRenderer): (number | null)[][] => {
  const root = tree.toJSON();
  if (!isNode(root)) throw new Error('Calendar rendered nothing');
  // The header row and the weekday row carry extra utilities in their
  // className, so an exact match selects only the six week rows.
  const rows = collect(root, (node) => node.props?.className === 'flex-row');
  return rows.map((row) =>
    (row.children ?? []).map((cell) => {
      if (!isNode(cell)) return null;
      const label = textOf(cell);
      return label === '' ? null : Number(label);
    }),
  );
};

const dayNumbers = (tree: TestRenderer.ReactTestRenderer): number[] =>
  dayGrid(tree)
    .flat()
    .filter((day): day is number => day !== null);

const pressText = (tree: TestRenderer.ReactTestRenderer, label: string | number) => {
  const button = tree.root
    .findAllByType(TouchableOpacity)
    .find((node) => node.findAllByType(Text).some((text) => text.props.children === label));
  if (!button) throw new Error(`No button labelled ${label}`);
  act(() => {
    button.props.onPress();
  });
};

const headerTitle = (tree: TestRenderer.ReactTestRenderer): string => {
  const title = tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .find((child): child is string => typeof child === 'string' && /\d/.test(child));
  if (!title) throw new Error('No header title rendered');
  return title;
};

describe('Calendar', () => {
  it('aligns each day under its weekday column', () => {
    // 1 April 2026 is a Wednesday: three blank slots lead the first row.
    const grid = dayGrid(renderCalendar(new Date(2026, 3, 15)));

    expect(grid).toHaveLength(6);
    expect(grid[0]).toEqual([null, null, null, 1, 2, 3, 4]);
    expect(grid[1]).toEqual([5, 6, 7, 8, 9, 10, 11]);
    // April has 30 days, so the last populated row stops mid-week.
    expect(grid[4]).toEqual([26, 27, 28, 29, 30, null, null]);
    expect(grid[5]).toEqual([null, null, null, null, null, null, null]);
  });

  it('renders a month that starts on a Sunday with no leading blanks', () => {
    // 1 February 2026 is a Sunday — the zero-offset edge of the same maths.
    const grid = dayGrid(renderCalendar(new Date(2026, 1, 10)));

    expect(grid[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dayNumbers(renderCalendar(new Date(2026, 1, 10)))).toEqual(
      Array.from({ length: 28 }, (_, index) => index + 1),
    );
  });

  it('renders a leap February in full', () => {
    expect(dayNumbers(renderCalendar(new Date(2028, 1, 5)))).toHaveLength(29);
  });

  it('reports midnight of the tapped day in the device time zone', () => {
    const onChange = jest.fn();
    const tree = renderCalendar(new Date(2026, 1, 10, 18, 30), onChange);

    pressText(tree, 24);

    expect(onChange).toHaveBeenCalledTimes(1);
    const selected: Date = onChange.mock.calls[0][0];
    expect([
      selected.getFullYear(),
      selected.getMonth(),
      selected.getDate(),
      selected.getHours(),
      selected.getMinutes(),
    ]).toEqual([2026, 1, 24, 0, 0]);
  });

  it('steps one month at a time from the header arrows', () => {
    const tree = renderCalendar(new Date(2026, 0, 15));
    expect(headerTitle(tree)).toBe('January 2026');

    const [previous, , next] = tree.root.findAllByType(TouchableOpacity);
    act(() => {
      previous.props.onPress();
    });
    // Stepping back from January must roll the year over, not produce month -1.
    expect(headerTitle(tree)).toBe('December 2025');

    act(() => {
      next.props.onPress();
      next.props.onPress();
    });
    expect(headerTitle(tree)).toBe('February 2026');
  });

  it('jumps to a distant month through the year and month panes', () => {
    const tree = renderCalendar(new Date(2026, 0, 15));

    pressText(tree, 'January 2026'); // days -> months
    expect(headerTitle(tree)).toBe('2026');

    pressText(tree, '2026'); // months -> years
    expect(headerTitle(tree)).toBe('2016–2027');

    pressText(tree, 2024); // years -> months
    expect(headerTitle(tree)).toBe('2024');

    pressText(tree, 'Sep'); // months -> days
    expect(headerTitle(tree)).toBe('September 2024');
    expect(dayNumbers(tree)).toHaveLength(30);
  });

  it('re-centres on the selection when the controlled value moves months', () => {
    const tree = renderCalendar(new Date(2026, 0, 15));
    const [previous] = tree.root.findAllByType(TouchableOpacity);
    act(() => {
      previous.props.onPress();
    });
    expect(headerTitle(tree)).toBe('December 2025');

    act(() => {
      tree.update(<Calendar value={new Date(2026, 4, 3)} onChange={() => {}} />);
    });
    expect(headerTitle(tree)).toBe('May 2026');
  });
});
