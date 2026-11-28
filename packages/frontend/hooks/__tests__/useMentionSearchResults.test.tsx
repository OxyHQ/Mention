import TestRenderer, { act } from 'react-test-renderer';
import { useMentionSearchResults, type MentionSearchResults } from '../useMentionSearchResults';
import {
  createMentionSearchCache,
  type MentionSearchCache,
  type MentionUser,
} from '@/utils/mentionSearch';

const alice: MentionUser = { id: 'alice-id', username: 'alice' };

let latest: MentionSearchResults;
function Probe({ query, cache }: { query: string; cache: MentionSearchCache }) {
  latest = useMentionSearchResults(query, cache);
  return null;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useMentionSearchResults', () => {
  it('answers from what the session already searched, without asking again', async () => {
    const fetchUsers = jest.fn(async () => [alice]);
    const cache = createMentionSearchCache(fetchUsers);
    await cache.search('ali');

    act(() => {
      TestRenderer.create(<Probe query="ali" cache={cache} />);
    });

    expect(latest).toEqual({ users: [alice], loading: false });
    expect(fetchUsers).toHaveBeenCalledTimes(1);
  });

  it("searches after the debounce, and never offers the previous query's accounts meanwhile", async () => {
    jest.useFakeTimers();
    const fetchUsers = jest.fn(async (query: string) => (query === 'ali' ? [alice] : []));
    const cache = createMentionSearchCache(fetchUsers);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe query="ali" cache={cache} />);
    });
    expect(latest).toEqual({ users: [], loading: true });
    expect(fetchUsers).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(fetchUsers).toHaveBeenCalledWith('ali');
    expect(latest).toEqual({ users: [alice], loading: false });

    act(() => {
      renderer.update(<Probe query="zed" cache={cache} />);
    });
    expect(latest).toEqual({ users: [], loading: true });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(latest).toEqual({ users: [], loading: false });
  });

  it('asks nothing for an empty query, and a failed search answers "nobody"', async () => {
    jest.useFakeTimers();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchUsers = jest.fn(async () => {
      throw new Error('offline');
    });
    const cache = createMentionSearchCache(fetchUsers);

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe query="" cache={cache} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(latest).toEqual({ users: [], loading: false });
    expect(fetchUsers).not.toHaveBeenCalled();

    act(() => {
      renderer.update(<Probe query="ali" cache={cache} />);
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(latest).toEqual({ users: [], loading: false });
    error.mockRestore();
  });
});
