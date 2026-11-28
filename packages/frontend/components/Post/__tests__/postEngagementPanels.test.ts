import { usePostEngagementPanels } from '../postEngagementPanels';

const destination = (postId: string, route = `/p/${postId}`) => ({
  postId,
  route,
  kind: 'likes' as const,
  navigate: jest.fn(),
});

beforeEach(() => usePostEngagementPanels.setState({ viewer: null, generation: 0, panels: {} }));

it('opens independent supporting panels and retains only the closing content for its exit', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  store.open('user:a', 1, 'main', destination('post-1'));
  store.open('user:a', 1, 'deck-2', destination('post-2'));
  store.close('user:a', 1, 'main');
  expect(usePostEngagementPanels.getState().panels.main).toMatchObject({
    isOpen: false,
    destination: { postId: 'post-1' },
  });
  expect(usePostEngagementPanels.getState().panels['deck-2']?.isOpen).toBe(true);
});

it('clears destinations on account switch and rejects callbacks from an earlier visit to the same account', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  store.open('user:a', 1, 'main', destination('private-post'));
  store.activate('user:b');
  expect(usePostEngagementPanels.getState().panels).toEqual({});
  store.open('user:a', 1, 'main', destination('private-post'));
  expect(usePostEngagementPanels.getState().panels).toEqual({});
  store.activate('user:a');
  store.open('user:a', 3, 'main', destination('new-post'));
  store.close('user:a', 1, 'main');
  store.open('user:a', 1, 'main', destination('private-post'));
  expect(usePostEngagementPanels.getState().panels.main).toMatchObject({
    isOpen: true,
    destination: { postId: 'new-post' },
  });
});

it('ignores a departing route after another post opened in the same host', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('anonymous');
  const current = destination('new-post');
  store.open('anonymous', 1, 'main', current);
  store.close('anonymous', 1, 'main', '/p/old-post');
  expect(usePostEngagementPanels.getState().panels.main?.isOpen).toBe(true);
  store.close('anonymous', 1, 'main', '/p/new-post');
  expect(usePostEngagementPanels.getState().panels.main).toMatchObject({
    isOpen: false,
    destination: current,
  });
  store.completeClose('anonymous', 1, 'main', current);
  expect(usePostEngagementPanels.getState().panels.main).toBeUndefined();
});

it('never releases open content or lets an old completion clear a reopened destination', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('anonymous');
  const first = destination('post-1');
  store.open('anonymous', 1, 'main', first);
  store.completeClose('anonymous', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main?.isOpen).toBe(true);
  store.close('anonymous', 1, 'main');
  const reopened = destination('post-1');
  store.open('anonymous', 1, 'main', reopened);
  store.completeClose('anonymous', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main?.destination).toBe(reopened);
  store.close('anonymous', 1, 'main');
  store.completeClose('anonymous', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main?.destination).toBe(reopened);
  store.completeClose('anonymous', 1, 'main', reopened);
  expect(usePostEngagementPanels.getState().panels.main).toBeUndefined();
});

it('does not release a new account visit when an earlier exit completes', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  const first = destination('post-1');
  store.open('user:a', 1, 'main', first);
  store.close('user:a', 1, 'main');
  store.activate('user:b');
  store.activate('user:a');
  store.open('user:a', 3, 'main', first);
  store.close('user:a', 3, 'main');
  store.completeClose('user:a', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main?.destination).toBe(first);
  store.completeClose('user:a', 3, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main).toBeUndefined();
});

it('immediately drops removed hosts and releases everything when their layout unmounts', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('anonymous');
  store.open('anonymous', 1, 'deleted-column', destination('post-1'));
  store.open('anonymous', 1, 'main', destination('post-2'));
  store.close('anonymous', 1, 'deleted-column');
  store.retainHosts('anonymous', 1, ['main']);
  expect(Object.keys(usePostEngagementPanels.getState().panels)).toEqual(['main']);
  store.retainHosts('anonymous', 0, []);
  expect(usePostEngagementPanels.getState().panels.main?.isOpen).toBe(true);
  store.retainHosts('anonymous', 1, []);
  expect(usePostEngagementPanels.getState().panels).toEqual({});
});

const repliesDestination = (postId = 'video-1') => ({
  ...destination(postId, '/videos'),
  kind: 'replies' as const,
});

it('keeps inline replies available after sheet dismissal and rejects an old destination dismissal', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  const first = repliesDestination();
  store.open('user:a', 1, 'main', first, true);
  const draft = usePostEngagementPanels.getState().panels.main?.replyDraft;
  expect(usePostEngagementPanels.getState().panels.main).toMatchObject({
    isOpen: true,
    floatingOpen: false,
  });
  draft?.store.getState().setText('unfinished reply');
  const focused = repliesDestination();
  store.open('user:a', 1, 'main', focused);
  expect(usePostEngagementPanels.getState().panels.main?.replyDraft).toBe(draft);
  store.dismissFloating('user:a', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main?.floatingOpen).toBe(true);
  store.dismissFloating('user:a', 1, 'main', focused);
  expect(usePostEngagementPanels.getState().panels.main).toMatchObject({
    isOpen: true,
    floatingOpen: false,
  });
  expect(draft?.store.getState().text).toBe('unfinished reply');
  expect(draft?.isCurrent?.()).toBe(true);
});

it('reopens automatic replies with a new owner after route departure, fencing pending work permanently', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  const first = repliesDestination();
  store.open('user:a', 1, 'main', first, true);
  const oldDraft = usePostEngagementPanels.getState().panels.main?.replyDraft;
  oldDraft?.store.getState().setText('old route reply');
  oldDraft?.store.getState().begin();
  store.close('user:a', 1, 'main', '/videos');
  expect(oldDraft?.isCurrent?.()).toBe(false);
  store.open('user:a', 1, 'main', repliesDestination(), true);
  const next = usePostEngagementPanels.getState().panels.main;
  expect(next?.isOpen).toBe(true);
  expect(next?.replyDraft).not.toBe(oldDraft);
  expect(next?.replyDraft?.store.getState().text).toBe('');
  expect(oldDraft?.isCurrent?.()).toBe(false);
  store.completeClose('user:a', 1, 'main', first);
  expect(usePostEngagementPanels.getState().panels.main).toBe(next);
});

it('isolates draft updates from layout subscriptions and invalidates removed or switched owners', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('user:a');
  store.open('user:a', 1, 'main', repliesDestination(), true);
  const first = usePostEngagementPanels.getState().panels.main?.replyDraft;
  const layoutChanged = jest.fn();
  const unsubscribe = usePostEngagementPanels.subscribe(layoutChanged);
  first?.store.getState().setText('typing does not redraw layout');
  expect(layoutChanged).not.toHaveBeenCalled();
  store.retainHosts('user:a', 1, []);
  expect(first?.isCurrent?.()).toBe(false);
  store.open('user:a', 1, 'main', repliesDestination(), true);
  const second = usePostEngagementPanels.getState().panels.main?.replyDraft;
  store.activate('user:b');
  store.activate('user:a');
  expect(second?.isCurrent?.()).toBe(false);
  unsubscribe();
});
