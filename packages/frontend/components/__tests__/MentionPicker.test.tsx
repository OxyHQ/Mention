import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import MentionPicker from '../MentionPicker';
import type { MentionUser } from '@/utils/mentionSearch';

let mockListProps: Record<string, unknown> | null = null;
jest.mock('@oxy.so/bloom/chat-composer', () => ({
  SuggestionList: (props: Record<string, unknown>) => {
    mockListProps = props;
    return null;
  },
}));

const alice: MentionUser = {
  id: 'alice-id',
  username: 'alice',
  displayName: 'Alice',
  avatar: 'file-alice',
  verified: true,
};
const bob: MentionUser = { id: 'bob-id', username: 'bob' };

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mockListProps = null;
});

function render(props: Partial<React.ComponentProps<typeof MentionPicker>> = {}) {
  const onSelect = jest.fn();
  const onActiveIndexChange = jest.fn();
  act(() => {
    TestRenderer.create(
      <MentionPicker
        users={[alice, bob]}
        loading={false}
        activeIndex={1}
        onActiveIndexChange={onActiveIndexChange}
        onSelect={onSelect}
        {...props}
      />,
    );
  });
  return { onSelect, onActiveIndexChange };
}

describe('MentionPicker', () => {
  it("is Bloom's people list, naming each account once and marking the verified", () => {
    render();

    expect(mockListProps?.kind).toBe('mention');
    expect(mockListProps?.suggestions).toEqual([
      { id: 'alice-id', label: 'Alice', handle: '@alice', avatar: 'file-alice', verified: true },
      // No display name: the handle IS the name, not repeated beside itself.
      { id: 'bob-id', label: '@bob', handle: undefined, avatar: undefined, verified: undefined },
    ]);
    expect(mockListProps?.activeIndex).toBe(1);
    // A picker the author opened answers "nobody" rather than vanishing.
    expect(mockListProps?.showEmpty).toBe(true);
  });

  it("selects the account behind the chosen row and reports the pointer's highlight", () => {
    const { onSelect, onActiveIndexChange } = render();

    act(() => {
      (mockListProps?.onSelectSuggestion as (s: unknown, index: number) => void)({}, 1);
      (mockListProps?.onActiveIndexChange as (index: number) => void)(0);
    });

    expect(onSelect).toHaveBeenCalledWith(bob);
    expect(onActiveIndexChange).toHaveBeenCalledWith(0);
  });

  it("hands the pending search to Bloom's searching line", () => {
    render({ users: [], loading: true });

    expect(mockListProps?.loading).toBe(true);
    expect(mockListProps?.suggestions).toEqual([]);
  });
});
