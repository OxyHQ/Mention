import TestRenderer, { act } from 'react-test-renderer';
import { useFeedRankingStaleness } from '../useFeedRankingStaleness';
import { notifyFeedRankingChanged } from '@/stores/feedRankingInvalidation';

it('withdraws old evidence synchronously, keeps it withdrawn on failed refresh, and restores only a fresh read', () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100);
  let value = false;
  function Probe({
    viewerId,
    readAt,
    enabled = true,
  }: {
    viewerId: string;
    readAt: number;
    enabled?: boolean;
  }) {
    value = useFeedRankingStaleness({ type: 'for_you', viewerId }, readAt, enabled);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(<Probe viewerId="social-viewer-a" readAt={101} />);
  });
  if (!renderer) throw new Error('Probe did not mount');
  const tree = renderer;
  expect(value).toBe(false);
  clock.mockReturnValue(200);
  act(() => notifyFeedRankingChanged('social-viewer-a'));
  expect(value).toBe(true);
  act(() => tree.update(<Probe viewerId="social-viewer-a" readAt={101} />));
  expect(value).toBe(true);
  act(() => tree.update(<Probe viewerId="social-viewer-a" readAt={201} />));
  expect(value).toBe(false);
  act(() => tree.update(<Probe viewerId="social-viewer-b" readAt={101} />));
  expect(value).toBe(false);
  act(() => tree.update(<Probe viewerId="social-viewer-a" readAt={101} enabled={false} />));
  expect(value).toBe(false);
  act(() => notifyFeedRankingChanged('social-viewer-a'));
  expect(value).toBe(false);
  act(() => tree.unmount());
  clock.mockRestore();
});
