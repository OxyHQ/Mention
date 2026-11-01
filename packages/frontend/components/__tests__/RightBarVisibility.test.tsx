import TestRenderer, { act } from 'react-test-renderer';
import { RightBar } from '../RightBar';

let mockPanel = { active: true, visibilityReady: false };
const mockStart = jest.fn();
const mockStop = jest.fn();

jest.mock('@oxy.so/bloom/app-shell', () => ({ useAppShellPanel: () => mockPanel }));
jest.mock('@/context/VideosRailContext', () => ({ useVideosRail: () => ({ active: false }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: jest.fn() }));
jest.mock('../videos/LazyVideoReplies', () => ({ LazyVideoReplies: () => null }));
jest.mock('../widgets/WidgetManager', () => ({
  WidgetManager: () => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => {
      mockStart();
      return () => mockStop();
    }, []);
    return null;
  },
}));
jest.mock('../SearchBar', () => ({
  SearchBar: () => {
    const React = jest.requireActual<typeof import('react')>('react');
    const { TextInput } = jest.requireActual<typeof import('react-native')>('react-native');
    const [value, setValue] = React.useState('');
    return React.createElement(TextInput, { testID: 'search', value, onChangeText: setValue });
  },
}));

it('suspends hidden rail effects and preserves its state when it returns', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<RightBar />);
  });
  expect(mockStart).not.toHaveBeenCalled();

  mockPanel = { active: true, visibilityReady: true };
  act(() => renderer.update(<RightBar />));
  expect(mockStart).toHaveBeenCalledTimes(1);
  act(() => renderer.root.findByProps({ testID: 'search' }).props.onChangeText('retained'));

  mockPanel = { active: false, visibilityReady: true };
  act(() => renderer.update(<RightBar />));
  expect(mockStop).toHaveBeenCalledTimes(1);
  mockPanel = { active: true, visibilityReady: true };
  act(() => renderer.update(<RightBar />));
  expect(mockStart).toHaveBeenCalledTimes(2);
  expect(renderer.root.findByProps({ testID: 'search' }).props.value).toBe('retained');
  act(() => renderer.unmount());
});
