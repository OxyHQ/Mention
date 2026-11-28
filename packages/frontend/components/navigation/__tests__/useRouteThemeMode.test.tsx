import { BloomThemeProvider, useBloomTheme } from '@oxy.so/bloom/theme';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { emptySnapshot, useDeckSettings } from '@/components/deck/deckSettings';
import { useRouteThemeMode } from '../useRouteThemeMode';

let mockPathname = '/';
let mockDeckAvailable = false;
jest.mock('expo-router', () => ({ usePathname: () => mockPathname }));
jest.mock('@/components/deck/useDeckAvailable', () => ({
  useDeckAvailable: () => mockDeckAvailable,
}));

const THEME_KEY = 'test.theme';
const trees: TestRenderer.ReactTestRenderer[] = [];

function renderTheme() {
  const storage = { getItem: () => '{"mode":"light"}', setItem: jest.fn() };
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<AppTheme storage={storage} />);
  });
  trees.push(tree);

  return {
    appearance: () => tree.root.findByType(Text).props.children,
    changePreference: () => act(() => tree.root.findByType(Text).props.onPress()),
    refresh: () => act(() => tree.update(<AppTheme storage={storage} />)),
    storage,
  };
}

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
});

function ThemeProbe() {
  const { theme, mode, setMode } = useBloomTheme();
  return <Text onPress={() => setMode('system')}>{`${theme.mode}/${mode}`}</Text>;
}

function AppTheme({ storage }: { storage: { getItem: () => string; setItem: jest.Mock } }) {
  const modeOverride = useRouteThemeMode();
  return (
    <BloomThemeProvider
      fonts={false}
      modeOverride={modeOverride}
      persistKey={THEME_KEY}
      storage={storage}
    >
      <ThemeProbe />
    </BloomThemeProvider>
  );
}

beforeEach(() => {
  mockPathname = '/';
  mockDeckAvailable = false;
  useDeckSettings.setState({ ...emptySnapshot(), deckEnabled: false, activePanel: undefined });
});

it('applies dark across video routes and restores the saved theme on exit', () => {
  const theme = renderTheme();
  expect(theme.appearance()).toBe('light/light');

  for (const route of ['/videos', '/watch/123', '/@nate/videos', '/video-upload']) {
    mockPathname = route;
    theme.refresh();
    expect(theme.appearance()).toBe('dark/light');
  }

  mockPathname = '/@nate/media';
  theme.refresh();
  expect(theme.appearance()).toBe('light/light');
  expect(theme.storage.setItem).not.toHaveBeenCalled();
});

it('keeps applying dark while the viewer changes their saved preference', () => {
  mockPathname = '/videos';
  const theme = renderTheme();
  theme.changePreference();
  expect(theme.appearance()).toBe('dark/system');
  expect(theme.storage.setItem).toHaveBeenCalledWith(
    THEME_KEY,
    expect.stringContaining('"mode":"system"'),
  );

  mockPathname = '/';
  theme.refresh();
  expect(theme.appearance()).toBe('light/system');
});

it('honors a video route in the focused Deck column', () => {
  mockPathname = '/deck';
  mockDeckAvailable = true;
  const { panels } = useDeckSettings.getState();
  useDeckSettings.setState({
    activePanel: 'deck-0',
    panels: {
      ...panels,
      'deck-0': {
        ...panels['deck-0'],
        navigation: {
          index: 0,
          entries: [{ name: '/watch/123?mediaIndex=0', key: 'watch' }],
        },
      },
    },
  });
  const theme = renderTheme();
  expect(theme.appearance()).toBe('dark/light');

  mockDeckAvailable = false;
  theme.refresh();
  expect(theme.appearance()).toBe('light/light');
});
