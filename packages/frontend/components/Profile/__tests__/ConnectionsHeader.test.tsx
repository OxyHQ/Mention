import TestRenderer, { act } from 'react-test-renderer';
import { ConnectionsHeader } from '../ConnectionsHeader';
import type { ProfileData } from '@/hooks/useProfileData';

let mockPathname = '/@nate/followers';
let mockProfile: {
  username: string;
  design: { displayName: string };
  isFederated?: boolean;
  instance?: string;
} | null = {
  username: 'nate',
  design: { displayName: 'Nate' },
};
const mockPush = jest.fn();

jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: (props: object) => <header {...props} />,
}));
jest.mock('@oxy.so/bloom/tabs', () => ({
  Tabs: () => null,
  TabsTrigger: () => null,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));
jest.mock('@/lib/navigation/router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: mockPush }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/@nate/followers';
  mockProfile = { username: 'nate', design: { displayName: 'Nate' } };
});

function render() {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <ConnectionsHeader
        username="@nate"
        profileData={mockProfile as unknown as ProfileData | null}
      />,
    );
  });
  if (!tree) throw new Error('Connections header did not render');
  return tree;
}

test.each([
  ['/followers', 'followers', 'Nate Followers'],
  ['/following', 'following', 'Nate Following'],
  ['/in-common', 'in-common', 'In common'],
  ['/who-may-know', 'who-may-know', 'Who May Know'],
  ['/connections', 'followers', 'Nate Followers'],
])('shows the selected tab and title for %s', (path, selected, title) => {
  mockPathname = `/@nate${path}`;
  const tree = render();
  const header = tree.root.findByType('header');
  const tabs = header.props.accessory;
  expect(header.props.title).toBe(title);
  expect(tabs.props.value).toBe(selected);
  expect(
    tabs.props.children.map((child: { props: { value: string } }) => child.props.value),
  ).toEqual(['followers', 'following', 'in-common', 'who-may-know']);
  act(() => tree.unmount());
});

test('navigates between tabs using the resolved profile handle', () => {
  mockProfile = { username: 'alice', design: { displayName: 'Alice' } };
  const tree = render();
  const tabs = tree.root.findByType('header').props.accessory;
  act(() => tabs.props.onValueChange('who-may-know'));
  expect(mockPush).toHaveBeenCalledWith('/@alice/who-may-know');
  act(() => tree.unmount());
});

test('falls back to the route handle and an unprefixed title before profile data loads', () => {
  mockProfile = null;
  const tree = render();
  const header = tree.root.findByType('header');
  expect(header.props.title).toBe('Followers');
  act(() => header.props.accessory.props.onValueChange('following'));
  expect(mockPush).toHaveBeenCalledWith('/@nate/following');
  act(() => tree.unmount());
});
