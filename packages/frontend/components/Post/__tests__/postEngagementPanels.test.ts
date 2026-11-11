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

it('does not close a new route when the previous route releases its panel', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('anonymous');
  store.open('anonymous', 1, 'main', destination('new-post'));
  store.release('anonymous', 1, 'main', '/p/old-post');
  expect(usePostEngagementPanels.getState().panels.main?.isOpen).toBe(true);
  store.release('anonymous', 1, 'main', '/p/new-post');
  expect(usePostEngagementPanels.getState().panels.main).toBeUndefined();
});

it('releases a closed destination when its route or Deck column unmounts', () => {
  const store = usePostEngagementPanels.getState();
  store.activate('anonymous');
  store.open('anonymous', 1, 'deleted-column', destination('post-1'));
  store.close('anonymous', 1, 'deleted-column');
  store.release('anonymous', 1, 'deleted-column', '/p/post-1');
  expect(usePostEngagementPanels.getState().panels).toEqual({});
});
