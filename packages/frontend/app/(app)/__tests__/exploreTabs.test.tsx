jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  Screen: ({
    header,
    children,
    bottomBar,
  }: {
    header?: React.ReactNode;
    children?: React.ReactNode;
    bottomBar?: React.ReactNode;
  }) => (
    <>
      {header}
      {children}
      {bottomBar}
    </>
  ),
}));
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
let mockPathname = '/explore';
type TabsProps = {
  value: string;
  onValueChange: (value: string) => void;
  pressOpenTab?: 'report' | 'reselect';
};
let mockTabsProps: TabsProps | undefined;

jest.mock('expo-router', () => ({
  useRouter: () => jest.requireMock('expo-router').router,
  router: { push: (href: string) => mockPush(href) },
  usePathname: () => mockPathname,
  useIsFocused: () => true,
  Slot: () => null,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/tabs', () => ({
  Tabs: (props: TabsProps) => {
    mockTabsProps = props;
    return null;
  },
  TabsTrigger: () => null,
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));

// The mocks above must be installed first.
import ExploreLayout from '../explore/_layout';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

/** Under Bloom's theme provider: the language paints its text and glyphs from the theme, as the app's provider supplies it. */
function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}

function renderAt(pathname: string) {
  mockPathname = pathname;
  act(() => {
    TestRenderer.create(themed(<ExploreLayout />));
  });
  if (!mockTabsProps) throw new Error('Explore rendered no tab strip');
  return mockTabsProps;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTabsProps = undefined;
});

describe('Explore tabs', () => {
  it('selects the tab whose route is the current page', () => {
    expect(renderAt('/explore').value).toBe('all');
    expect(renderAt('/explore/media').value).toBe('media');
    expect(renderAt('/explore/who-to-follow').value).toBe('people');
    expect(renderAt('/explore/who-to-follow/new').value).toBe('people');
  });

  it('pushes the route of any other tab', () => {
    renderAt('/explore').onValueChange('trending');
    expect(mockPush).toHaveBeenCalledWith('/explore/trending');
  });

  it('reselects the tab already open instead of pushing it again', () => {
    expect(renderAt('/explore/media').pressOpenTab).toBe('reselect');
  });
});
