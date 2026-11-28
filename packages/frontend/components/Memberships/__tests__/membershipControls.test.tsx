import TestRenderer, { act } from 'react-test-renderer';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import type { MembershipContent, MembershipTier } from '@mention/shared-types';
const mockApi = {
  createContent: jest.fn(),
  upload: jest.fn(),
  discardUpload: jest.fn(),
  updateTier: jest.fn(),
  createTier: jest.fn(),
  vote: jest.fn(),
  report: jest.fn(),
  removeContent: jest.fn(),
  revoke: jest.fn(),
  download: jest.fn(),
};
const mockPick = jest.fn();
const mockOpen = jest.fn();
jest.mock('@/services/membershipsService', () => ({
  membershipsService: new Proxy(
    {},
    { get: (_target, name: keyof typeof mockApi) => mockApi[name] },
  ),
}));
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockPick(...args),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    constructor() {
      throw new Error('Web picker must use its selected File');
    }
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/card', () => ({ Card: 'Card' }));
jest.mock('@oxy.so/bloom/text-field', () => ({ TextField: 'TextField', TextFieldInput: 'Input' }));
jest.mock('@oxy.so/bloom/textarea', () => ({ Textarea: 'Textarea' }));
jest.mock('@/utils/alerts', () => ({ confirmDestructive: async () => true }));
import { Linking } from 'react-native';
import { MembershipComposer } from '../MembershipComposer';
import { MembershipTierEditor } from '../MembershipTierEditor';
import { MembershipContentCard } from '../MembershipContentCard';

let tree: TestRenderer.ReactTestRenderer | undefined;
const changed = jest.fn(async () => {});
const tier: MembershipTier = {
  id: 'tier',
  communityId: 'community',
  name: 'Members',
  description: 'Private',
  kind: 'free',
  status: 'active',
  benefits: ['content_read', 'discussion_write', 'polls_vote', 'media_download'],
};
function root() {
  if (!tree) throw new Error('Component missing');
  return tree.root;
}
function button(label: string) {
  const node = root()
    .findAllByType(Button)
    .find((entry) => entry.props.children === label);
  if (!node) throw new Error(`Button missing: ${label}`);
  return node;
}
async function press(label: string) {
  await act(async () => {
    button(label).props.onPress();
  });
}
function input(label: string, value: string) {
  const node = root()
    .findAllByType(TextFieldInput)
    .find((entry) => entry.props.label === label);
  if (!node) throw new Error(`Input missing: ${label}`);
  act(() => node.props.onChangeText(value));
}
function area(label: string, value: string) {
  const node = root()
    .findAllByType(Textarea)
    .find((entry) => entry.props.accessibilityLabel === label);
  if (!node) throw new Error(`Textarea missing: ${label}`);
  act(() => node.props.onChangeText(value));
}
beforeEach(() => {
  jest.clearAllMocks();
  for (const method of Object.values(mockApi)) method.mockResolvedValue(undefined);
  jest.spyOn(Linking, 'openURL').mockImplementation(mockOpen);
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
  jest.restoreAllMocks();
});
it('publishes a protected poll with an explicit public teaser and tier policy', async () => {
  act(() => {
    tree = TestRenderer.create(
      <MembershipComposer communityId="community" manager tiers={[tier]} onCreated={changed} />,
    );
  });
  await press('Poll');
  input('Title', 'A title');
  area('Message for members', 'Private body');
  area('Optional public teaser', 'Public teaser');
  area('One option per line (2–10)', 'A\nB');
  await press('Members');
  await press('Publish to members');
  expect(mockApi.createContent).toHaveBeenCalledWith(
    'community',
    expect.objectContaining({
      kind: 'poll',
      title: 'A title',
      body: 'Private body',
      teaser: 'Public teaser',
      requiredTierIds: ['tier'],
      poll: { options: ['A', 'B'], endsAt: expect.any(String) },
    }),
  );
  expect(changed).toHaveBeenCalledTimes(1);
  expect(
    root()
      .findAllByType(Textarea)
      .find((node) => node.props.accessibilityLabel === 'Message for members')?.props.value,
  ).toBe('');
});
it('keeps a member reply in its parent and never offers operator publication controls', async () => {
  act(() => {
    tree = TestRenderer.create(
      <MembershipComposer
        communityId="community"
        manager={false}
        parentContentId="parent"
        tiers={[]}
        onCreated={changed}
      />,
    );
  });
  expect(
    root()
      .findAllByType(Button)
      .some((node) => node.props.children === 'Poll'),
  ).toBe(false);
  area('Message for members', 'Reply');
  await press('Publish to members');
  expect(mockApi.createContent).toHaveBeenCalledWith('community', {
    kind: 'discussion',
    body: 'Reply',
    parentContentId: 'parent',
    mediaIds: [],
  });
});
it('uploads selected bytes privately, lets the author discard a draft, and does not publish failed uploads', async () => {
  const bytes = new Uint8Array([1, 2]).buffer;
  mockPick.mockResolvedValue({
    canceled: false,
    assets: [
      {
        uri: 'blob:test',
        mimeType: 'image/png',
        file: { size: 2, type: 'image/png', arrayBuffer: async () => bytes },
      },
    ],
  });
  mockApi.upload.mockResolvedValue({ id: 'media', size: 2, mime: 'image/png' });
  act(() => {
    tree = TestRenderer.create(
      <MembershipComposer communityId="community" manager tiers={[tier]} onCreated={changed} />,
    );
  });
  await press('Attach a private file');
  expect(mockApi.upload).toHaveBeenCalledWith('community', bytes, 'image/png');
  await press('Remove');
  expect(mockApi.discardUpload).toHaveBeenCalledWith('community', 'media');
  mockPick.mockResolvedValue({ canceled: true });
  await press('Attach a private file');
  expect(mockApi.upload).toHaveBeenCalledTimes(1);
  mockPick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'blob:test', file: { size: 41 * 1024 * 1024 } }],
  });
  await press('Attach a private file');
  expect(JSON.stringify(tree?.toJSON())).toContain('40 MB');
  area('Message for members', 'Keep my draft');
  mockApi.createContent.mockRejectedValue(new Error('Unavailable'));
  await press('Publish to members');
  expect(
    root()
      .findAllByType(Textarea)
      .find((node) => node.props.accessibilityLabel === 'Message for members')?.props.value,
  ).toBe('Keep my draft');
});
it('edits tier benefits explicitly and retires a free tier without creating a payment', async () => {
  act(() => {
    tree = TestRenderer.create(
      <MembershipTierEditor communityId="community" tier={tier} onChange={changed} />,
    );
  });
  input('Tier name', 'Readers');
  area('Description', 'Only reading');
  await press('Participate in discussions');
  await press('Vote in polls');
  await press('Download private files');
  await press('Stop new memberships');
  expect(mockApi.updateTier).toHaveBeenCalledWith('community', 'tier', {
    name: 'Readers',
    description: 'Only reading',
    benefits: ['content_read'],
    status: 'retired',
  });
  expect(mockApi.createTier).not.toHaveBeenCalled();
});
it('creates only a paid draft and exposes an error without inventing an activation path', async () => {
  act(() => {
    tree = TestRenderer.create(<MembershipTierEditor communityId="community" onChange={changed} />);
  });
  input('Tier name', 'Supporters');
  area('Description', 'Planned');
  await press('Participate in discussions');
  await press('Save');
  expect(mockApi.createTier).toHaveBeenCalledWith('community', {
    name: 'Supporters',
    description: 'Planned',
    kind: 'paid',
    benefits: ['content_read', 'discussion_write'],
  });
  expect(
    root()
      .findAllByType(Button)
      .some((node) => node.props.children === 'Activate'),
  ).toBe(false);
  mockApi.createTier.mockRejectedValue(new Error('Unavailable'));
  input('Tier name', 'Retry');
  await press('Save');
  expect(JSON.stringify(tree?.toJSON())).toContain('The action could not be completed.');
});
const content: MembershipContent = {
  id: 'content',
  communityId: 'community',
  authorOxyUserId: 'author',
  kind: 'poll',
  teaser: null,
  title: 'Question',
  body: 'Protected body',
  parentContentId: null,
  requiredTierIds: [],
  createdAt: '',
  media: [{ id: 'media', mime: 'image/png', size: 1 }],
  poll: {
    endsAt: '2099-01-01T00:00:00.000Z',
    options: [{ id: 'option', text: 'A', votes: 0 }],
    selectedOptionId: null,
  },
};
it('uses private endpoints for voting, downloads and moderation, without retaining URLs in content', async () => {
  const thread = jest.fn();
  mockApi.download.mockResolvedValue({ url: 'https://files.test/signed', expiresIn: 300 });
  act(() => {
    tree = TestRenderer.create(
      <MembershipContentCard
        content={content}
        viewerId="manager"
        manager
        benefits={tier.benefits}
        onChange={changed}
        onThread={thread}
      />,
    );
  });
  await press('A · 0');
  expect(mockApi.vote).toHaveBeenCalledWith('content', 'option');
  await press('Open attachment {{number}}');
  expect(mockOpen).toHaveBeenCalledWith('https://files.test/signed');
  expect(JSON.stringify(tree?.toJSON())).not.toContain('https://files.test/signed');
  await press('Discussion');
  expect(thread).toHaveBeenCalledTimes(1);
  await press('Report');
  area('Reason for report', 'Please review');
  await press('Send report');
  expect(mockApi.report).toHaveBeenCalledWith('content', 'Please review');
  await press('Remove');
  expect(mockApi.removeContent).toHaveBeenCalledWith('content');
  await press('Revoke membership');
  expect(mockApi.revoke).toHaveBeenCalledWith('community', 'author');
});
it('disables ungranted poll and download actions and surfaces denial without opening a URL', async () => {
  act(() => {
    tree = TestRenderer.create(
      <MembershipContentCard
        content={content}
        viewerId="member"
        manager={false}
        benefits={['content_read']}
        onChange={changed}
      />,
    );
  });
  expect(button('A · 0').props.disabled).toBe(true);
  expect(button('Open attachment {{number}}').props.disabled).toBe(true);
  await press('Report');
  area('Reason for report', 'Reason');
  mockApi.report.mockRejectedValue(new Error('Access denied'));
  await press('Send report');
  expect(JSON.stringify(tree?.toJSON())).toContain('The action could not be completed.');
  expect(mockOpen).not.toHaveBeenCalled();
  await press('Cancel');
  expect(root().findAllByType(Textarea)).toHaveLength(0);
});
