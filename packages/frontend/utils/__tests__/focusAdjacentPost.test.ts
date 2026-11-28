import { adjacentRow, focusAdjacentPost, POST_FOCUS_TOP_OFFSET } from '../focusAdjacentPost';

const rows = [
  { top: -400, bottom: 40 },
  { top: 40, bottom: 500 },
  { top: 500, bottom: 900 },
];

describe('adjacentRow', () => {
  it('starts at the first post still readable below the header', () => {
    expect(adjacentRow(rows, -1, 1)).toBe(1);
    expect(adjacentRow(rows, -1, -1)).toBe(1);
  });

  it('moves one post and stops at either end', () => {
    expect(adjacentRow(rows, 1, 1)).toBe(2);
    expect(adjacentRow(rows, 1, -1)).toBe(0);
    expect(adjacentRow(rows, 2, 1)).toBe(2);
    expect(adjacentRow(rows, 0, -1)).toBe(0);
  });

  it('takes the last post when all are above, and none from an empty feed', () => {
    expect(adjacentRow([{ top: -200, bottom: 0 }], -1, 1)).toBe(0);
    expect(adjacentRow([], -1, 1)).toBe(-1);
  });
});

describe('focusAdjacentPost', () => {
  const row = (top: number, { drawn = true, hidden = false } = {}) => {
    const element = {
      getClientRects: () => (drawn ? [{}] : []),
      getBoundingClientRect: () => ({ top, bottom: top + 300 }),
      closest: () => (hidden ? {} : null),
      contains: (node: unknown) => node === element,
      setAttribute: jest.fn(),
      focus: jest.fn(),
      scrollIntoView: jest.fn(),
      style: {} as Record<string, string>,
    };
    return element;
  };
  const page = (elements: ReturnType<typeof row>[], active: unknown = null, dialog = false) =>
    ({
      querySelector: () => (dialog ? {} : null),
      querySelectorAll: () => elements,
      activeElement: active,
    }) as unknown as Document;

  it('focuses the next post in reading order and brings it below the header', () => {
    const first = row(POST_FOCUS_TOP_OFFSET);
    const second = row(600);
    // Mounted out of order, as a virtualized list may be.
    expect(focusAdjacentPost(1, page([second, first], first))).toBe(true);
    expect(second.setAttribute).toHaveBeenCalledWith('tabindex', '-1');
    expect(second.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(second.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(second.style.scrollMarginTop).toBe(`${POST_FOCUS_TOP_OFFSET}px`);
  });

  it('skips posts of a feed that is not in front', () => {
    const undrawn = row(120, { drawn: false });
    const covered = row(130, { hidden: true });
    const shown = row(500);
    focusAdjacentPost(1, page([undrawn, covered, shown]));
    expect(shown.focus).toHaveBeenCalled();
    expect(undrawn.focus).not.toHaveBeenCalled();
    expect(covered.focus).not.toHaveBeenCalled();
  });

  it('leaves the key alone under a dialog or without posts', () => {
    const only = row(200);
    expect(focusAdjacentPost(1, page([only], null, true))).toBe(false);
    expect(focusAdjacentPost(1, page([]))).toBe(false);
    expect(only.focus).not.toHaveBeenCalled();
  });
});
