import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockPush = jest.fn();
const mockReselect = jest.fn();
let mockPathname = '/explore';
type TabsProps = { value: string; onValueChange: (value: string) => void };
let mockTabsProps: TabsProps | undefined;

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href) },
  usePathname: () => mockPathname,
  Slot: () => null,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('@oxy.so/bloom/tabs', () => ({
  Tabs: (props: TabsProps) => { mockTabsProps = props; return null; },
  TabsTrigger: () => null,
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: () => null }));
jest.mock('@/assets/icons/search-icon', () => ({ Search: () => null }));
jest.mock('@/components/SEO', () => ({ SEO: () => null }));
jest.mock('@/context/ScreenReselectContext', () => ({
  useTabSelect: <T,>(active: T, select: (tab: T) => void) => (tab: T) => (tab === active ? mockReselect() : select(tab)),
}));

// eslint-disable-next-line import/first -- the mocks above must be installed first.
import ExploreLayout from '../explore/_layout';

function renderAt(pathname: string) {
  mockPathname = pathname;
  act(() => { TestRenderer.create(<ExploreLayout />); });
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
  });

  it('pushes the route of any other tab', () => {
    renderAt('/explore').onValueChange('trending');
    expect(mockPush).toHaveBeenCalledWith('/explore/trending');
    expect(mockReselect).not.toHaveBeenCalled();
  });

  it('reselects the tab already open instead of pushing it again', () => {
    renderAt('/explore/media').onValueChange('media');
    expect(mockReselect).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
