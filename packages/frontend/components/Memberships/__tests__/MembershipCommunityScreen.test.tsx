import { Button } from '@oxy.so/bloom/button';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text as MockText } from 'react-native';
import type { MembershipLandingResponse } from '@mention/shared-types';

let mockViewer = 'viewer-a';
let mockFocused = true;
let mockPrivateApi = true;
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
  useAuth: () => ({ user: { id: mockViewer }, canUsePrivateApi: mockPrivateApi }),
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
  mockPrivateApi = true;
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

it('fails closed before any protected request when community entitlement lookup fails', async () => {
  mockService.landing.mockRejectedValue(new Error('Entitlement service unavailable'));
  await mount();
  expect(text()).toContain('Community unavailable');
  expect(text()).not.toContain('PRIVATE BODY A');
  expect(mockService.content).not.toHaveBeenCalled();
  expect(mockService.readContent).not.toHaveBeenCalled();
});

it('withholds a previously visible body when refreshing the landing denies entitlement', async () => {
  await mount();
  expect(text()).toContain('PRIVATE BODY A');
  const reads = mockService.content.mock.calls.length;
  mockService.landing.mockRejectedValue(new Error('Community access revoked'));
  await act(async () => {
    await client.invalidateQueries({
      queryKey: membershipKeys.landing('viewer-a', 'community', true),
    });
  });
  await settle();
  expect(text()).toContain('Community unavailable');
  expect(text()).not.toContain('PRIVATE BODY A');
  expect(mockService.content).toHaveBeenCalledTimes(reads);
});

it('hides retained private content when unfocused and rechecks entitlement on returning', async () => {
  await mount();
  expect(text()).toContain('PRIVATE BODY A');
  const reads = mockService.content.mock.calls.length;
  mockFocused = false;
  act(() => tree?.update(render()));
  expect(text()).not.toContain('PRIVATE BODY A');
  mockService.landing.mockResolvedValue({ ...active, membership: null });
  mockFocused = true;
  act(() => tree?.update(render()));
  expect(text()).not.toContain('PRIVATE BODY A');
  await settle();
  await settle();
  expect(text()).not.toContain('PRIVATE BODY A');
  expect(mockService.content).toHaveBeenCalledTimes(reads);
});

const disclosedTier = {
  id: 'reader-tier',
  communityId: 'community',
  name: 'Reader pass',
  description: 'Read updates and vote on community decisions.',
  kind: 'free' as const,
  status: 'active' as const,
  benefits: ['content_read', 'polls_vote'] as const,
};
const publicLanding = () => ({
  ...active,
  membership: null,
  tiers: [
    { ...disclosedTier, benefits: [...disclosedTier.benefits] },
    {
      ...disclosedTier,
      id: 'paid-draft',
      name: 'Unpublished paid plan',
      kind: 'paid',
      status: 'draft',
    },
    { ...disclosedTier, id: 'old-tier', name: 'Retired reader tier', status: 'retired' },
  ],
});
it('shows the free tier and only its actual benefits before the member deliberately joins it', async () => {
  mockService.landing.mockResolvedValue(publicLanding());
  await mount();
  expect(text()).toContain('Reader pass');
  expect(text()).toContain(disclosedTier.description);
  expect(text()).toContain('Free memberships are available. Paid subscriptions are not enabled.');
  expect(text()).toContain('Read member content');
  expect(text()).toContain('Vote in polls');
  expect(text()).not.toContain('Participate in discussions');
  expect(text()).not.toContain('Download private files');
  expect(text()).not.toContain('Unpublished paid plan');
  expect(text()).not.toContain('Retired reader tier');
  expect(mockService.join).not.toHaveBeenCalled();
  const join = tree?.root
    .findAllByType(Button)
    .find((button) => button.props.children === 'Join free');
  expect(join).toBeDefined();
  await act(async () => {
    await join?.props.onPress();
  });
  expect(mockService.join).toHaveBeenCalledWith('community', 'reader-tier');
  expect(mockService.content).not.toHaveBeenCalled();
});
it('shows the same public free offer before sign-in without enabling a membership mutation', async () => {
  mockPrivateApi = false;
  mockService.landing.mockResolvedValue(publicLanding());
  await mount();
  expect(text()).toContain('Reader pass');
  expect(text()).toContain('Read member content');
  expect(text()).not.toContain('Unpublished paid plan');
  expect(
    tree?.root.findAllByType(Button).some((button) => button.props.children === 'Join free'),
  ).toBe(false);
  expect(mockService.join).not.toHaveBeenCalled();
  expect(mockService.content).not.toHaveBeenCalled();
});
