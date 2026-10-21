import TestRenderer, { act } from 'react-test-renderer';
import { useReloadOnFeedRuleChange } from '../useReloadOnFeedRuleChange';
import { invalidateSafetyFilters } from '@/stores/safetyInvalidation';
import { noteChannelBylineChanged } from '@/stores/bylineInvalidation';
import {
  noteReaderLanguages,
  resetReaderLanguageInvalidation,
} from '@/stores/readerLanguageInvalidation';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';

jest.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: jest.fn() } }));

it('keeps generic rule reloads active without a ranking identity and unsubscribes on disable', () => {
  resetReaderLanguageInvalidation();
  const reload = jest.fn();
  function Probe({ enabled }: { enabled: boolean }) {
    useReloadOnFeedRuleChange(enabled, reload);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Probe enabled />);
  });
  act(() => {
    notifyFeedRankingChanged('reader');
    invalidateSafetyFilters();
    noteChannelBylineChanged('channel');
    noteReaderLanguages('reader', ['en']);
    noteReaderLanguages('reader', ['es']);
  });
  expect(reload).toHaveBeenCalledTimes(3);
  act(() => {
    renderer?.update(<Probe enabled={false} />);
  });
  act(() => {
    invalidateSafetyFilters();
    noteChannelBylineChanged('channel');
    noteReaderLanguages('reader', ['fr']);
  });
  expect(reload).toHaveBeenCalledTimes(3);
  act(() => {
    renderer?.unmount();
  });
});
