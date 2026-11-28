import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  HASHTAG_SUGGESTION_DEBOUNCE_MS,
  HASHTAG_SUGGESTION_LIMIT,
  useHashtagSuggestions,
} from '../useHashtagSuggestions';

const mockSearch = jest.fn();
jest.mock('@/services/searchService', () => ({
  searchService: { searchHashtagsPage: (...args: unknown[]) => mockSearch(...args) },
}));

let result: readonly { tag: string; count: number }[];
function Probe({ query }: { query: string | null }) {
  result = useHashtagSuggestions(query);
  return null;
}

const tags = Array.from({ length: 8 }, (_, i) => ({ tag: `art${i}`, count: i }));
let tree: ReactTestRenderer;
const render = (query: string | null) =>
  act(() => {
    if (tree) tree.update(<Probe query={query} />);
    else tree = create(<Probe query={query} />);
  });
const wait = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(HASHTAG_SUGGESTION_DEBOUNCE_MS);
  });

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSearch.mockResolvedValue({ hashtags: tags });
});
afterEach(() => {
  act(() => tree.unmount());
  tree = undefined as unknown as ReactTestRenderer;
  jest.useRealTimers();
});

it('asks once for the text the author stopped on, and keeps a few rows', async () => {
  render('a');
  render('ar');
  await wait();
  expect(mockSearch).toHaveBeenCalledTimes(1);
  expect(mockSearch).toHaveBeenCalledWith('ar', 0, expect.any(AbortSignal));
  expect(result).toHaveLength(HASHTAG_SUGGESTION_LIMIT);
});

it('drops the rows as soon as the text asks for something else', async () => {
  render('art');
  await wait();
  render('arte');
  expect(result).toEqual([]);
  render(null);
  expect(result).toEqual([]);
});

it('offers nothing when the search fails', async () => {
  mockSearch.mockRejectedValue(new Error('offline'));
  render('art');
  await wait();
  expect(result).toEqual([]);
});
