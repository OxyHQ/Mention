import { Button } from '@oxy.so/bloom/button';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text as MockText } from 'react-native';
import type { MembershipLandingResponse } from '@mention/shared-types';

let mockViewer = 'viewer-a';
let mockFocused = true;
const mockService = {
  landing: jest.fn(),
  content: jest.fn(),
  readContent: jest.fn(),
  leave: jest.fn(),
  badge: jest.fn(),
  join: jest.fn(),
};
jest.mock('@/services/membershipsService', () => ({
  membershipsService: {
    landing: (...args: unknown[]) => mockService.landing(...args),
    content: (...args: unknown[]) => mockService.content(...args),
    readContent: (...args: unknown[]) => mockService.readContent(...args),
    leave: (...args: unknown[]) => mockService.leave(...args),
    badge: (...args: unknown[]) => mockService.badge(...args),
    join: (...args: unknown[]) => mockService.join(...args),
  },
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewer }, canUsePrivateApi: true }),
}));
jest.mock('@/lib/navigation/router', () => ({
  useIsFocused: () => mockFocused,
  useLocalSearchParams: () => ({ id: 'community' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/card', () => ({ Card: 'Card' }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: 'PageHeader' }));
jest.mock('@oxy.so/bloom/text-field', () => ({ TextField: 'TextField', TextFieldInput: 'Input' }));
jest.mock('@oxy.so/bloom/textarea', () => ({ Textarea: 'Textarea' }));
jest.mock('@/components/loading/ContentSkeleton', () => ({ ListSkeleton: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));
jest.mock('@/components/common/SignInRequired', () => ({ SignInRequired: () => null }));
jest.mock('@/components/Memberships/MembershipComposer', () => ({
  MembershipComposer: () => null,
}));
jest.mock('@/components/Memberships/MembershipTierEditor', () => ({
  MembershipTierEditor: () => null,
}));
jest.mock('@/components/Memberships/MembershipDirectory', () => ({
  MembershipDirectory: () => null,
}));
jest.mock('@/components/Memberships/MembershipContentCard', () => ({
  MembershipContentCard: ({ content }: { content: { body: string } }) => (
    <MockText>{content.body}</MockText>
  ),
}));
jest.mock('@/utils/alerts', () => ({ confirmDestructive: async () => true }));
import Screen from '../../../app/(app)/memberships/[id]';
import { membershipKeys } from '../membershipQueries';

const active: MembershipLandingResponse = {
  community: {
    id: 'community',
    ownerOxyUserId: 'owner',
    slug: 'community',
    name: 'Community',
    description: 'Public description',
    visibility: 'public',
    status: 'active',
    createdAt: '',
    updatedAt: '',
  },
  membership: {
    id: 'm',
    communityId: 'community',
    tierId: 't',
    state: 'active',
    publicBadge: false,
    startedAt: '',
    cancelledAt: null,
    accessEndsAt: null,
  },
  tiers: [],
  viewerBenefits: ['content_read', 'discussion_write', 'polls_vote', 'media_download'],
  canManage: false,
  paidSubscriptionsAvailable: false,
};
let client: QueryClient;
let tree: TestRenderer.ReactTestRenderer | undefined;
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};
const render = () => (
  <QueryClientProvider client={client}>
    <Screen />
  </QueryClientProvider>
);
const text = () => JSON.stringify(tree?.toJSON());
beforeEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
  mockViewer = 'viewer-a';
  mockFocused = true;
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mockService.landing.mockResolvedValue(active);
  mockService.content.mockResolvedValue({
    items: [{ id: 'post', body: 'PRIVATE BODY A' }],
    nextCursor: null,
  });
});
afterEach(() => {
  act(() => tree?.unmount());
  client.clear();
  tree = undefined;
});
async function mount() {
  await act(async () => {
    tree = TestRenderer.create(render());
  });
  await settle();
  await settle();
}
it('never requests a protected page for a nonmember', async () => {
  mockService.landing.mockResolvedValue({ ...active, membership: null });
  await mount();
  expect(mockService.content).not.toHaveBeenCalled();
  expect(text()).not.toContain('PRIVATE BODY A');
});
it('hides the previous viewer body immediately on account change and denies the new viewer', async () => {
  await mount();
  expect(text()).toContain('PRIVATE BODY A');
  const reads = mockService.content.mock.calls.length;
  mockService.landing.mockResolvedValue({ ...active, membership: null });
  mockViewer = 'viewer-b';
  act(() => tree?.update(render()));
  expect(text()).not.toContain('PRIVATE BODY A');
  await settle();
  expect(mockService.content).toHaveBeenCalledTimes(reads);
});
it('hides protected content while a leave request is still pending and drops cached pages', async () => {
  await mount();
  expect(text()).toContain('PRIVATE BODY A');
  let finish: (() => void) | undefined;
  mockService.leave.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const button = tree?.root
    .findAllByType(Button)
    .find((entry) => entry.props.children === 'Leave community');
  if (!button) throw new Error('Leave action missing');
  await act(async () => {
    button.props.onPress();
  });
  expect(text()).not.toContain('PRIVATE BODY A');
  expect(client.getQueryData(membershipKeys.content('viewer-a', 'community'))).toBeUndefined();
  mockService.landing.mockResolvedValue({ ...active, membership: null });
  if (!finish) throw new Error('Leave request missing');
  await act(async () => {
    finish?.();
  });
  await settle();
  expect(text()).not.toContain('PRIVATE BODY A');
});
it('never shows cached protected data when a refetch denies access', async () => {
  await mount();
  expect(text()).toContain('PRIVATE BODY A');
  mockService.content.mockRejectedValue(new Error('Access revoked'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: membershipKeys.content('viewer-a', 'community') });
  });
  await settle();
  expect(text()).not.toContain('PRIVATE BODY A');
});
