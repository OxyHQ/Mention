jest.mock('@oxy.so/bloom/skeleton', () => require('@/test-support/bloomSkeleton'));
import type React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { waitUntil } from '@/test-support/waitUntil';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Experience } from '@clarity.surf/sdk/experience';

// The first render of the editor is what first reads react-native's lazy
// `ScrollView`, `Modal` and `Text`, and on a cold transform cache (a new
// worktree, a first `--coverage` run) loading them took 3–8 s each, measured
// 2026-10-23 — past jest's 5 s default, inside whichever test renders first.
// Jest does not stop a test that times out: its tail ran on into the next tests'
// `renderer` and failed ten more. Warm, the same reads take under 0.5 s.
jest.setTimeout(30_000);

const mockSupervision = { ready: true, supervised: false, isError: false, refetch: jest.fn() };
jest.mock('@/hooks/useSupervisionState', () => ({ useSupervisionState: () => mockSupervision }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'empty-state' }));

const mockAuth = {
  user: { id: 'person' },
  isAuthenticated: true,
  canUsePrivateApi: true,
  oxyServices: {
    http: { getSessionEpoch: jest.fn(() => 0) },
    organizations: { batch: jest.fn(), search: jest.fn(), create: jest.fn() },
    safety: { organizations: jest.fn() },
  },
};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@/hooks/useCachedUser', () => ({ useCachedUserSnapshot: () => undefined }));
jest.mock('@/utils/userEnrichment', () => ({
  prewarmUsersByIds: jest.fn(() => Promise.resolve([])),
}));
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenReselectHandler: () => {} }));
jest.mock('expo-router', () => ({ Link: 'profile-link' }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'avatar' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'button' }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'loading' }));
jest.mock('@oxy.so/bloom/item', () => ({ Item: 'item' }));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: 'dialog',
  useDialogControl: () =>
    require('react').useMemo(
      () => ({ open: jest.fn(), close: (callback?: () => void) => callback?.() }),
      [],
    ),
}));
jest.mock('@oxy.so/bloom/switch', () => ({ Switch: 'switch' }));
jest.mock('@oxy.so/bloom/text-field', () => ({
  TextField: 'field',
  TextFieldInput: 'input',
  TextFieldLabel: 'label',
}));
jest.mock('@oxy.so/bloom/select', () => ({
  Select: 'select',
  SelectContent: 'options',
  SelectItem: 'option',
  SelectItemText: 'option-text',
  SelectTrigger: 'select-trigger',
  SelectValue: 'select-value',
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations = require('../../../locales/en.json');
      let value = key
        .split('.')
        .reduce(
          (part: unknown, field: string) =>
            part && typeof part === 'object' ? (part as Record<string, unknown>)[field] : undefined,
          translations,
        );
      if (typeof value !== 'string') value = options?.defaultValue ?? key;
      return String(value).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));
jest.mock('@/services/experienceService', () => ({
  experienceService: { list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() },
}));
jest.mock('@/services/searchService', () => ({
  searchService: { searchUsers: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn().mockResolvedValue(true) }));

import { experienceService } from '@/services/experienceService';
import { confirmDialog } from '@/utils/alerts';
import { ProfileExperience } from '../ProfileExperience';
import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { EmptyState } from '@/components/common/EmptyState';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Item } from '@oxy.so/bloom/item';
import { ExperienceEditor } from '../ExperienceEditor';
import type { Organization } from '@oxy.so/contracts';

const entry: Experience = {
  id: 'role',
  oxyUserId: 'person',
  title: 'Designer',
  employerOxyAccountId: 'org-apple',
  startDate: '2022-10',
  endDate: null,
  employmentType: 'full-time',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};
const organization: Organization = {
  accountId: 'org-apple',
  name: 'Apple',
  username: 'apple',
  avatar: null,
  organizationType: 'business',
  legalName: null,
  websiteUrl: 'https://apple.example',
  countryCode: 'US',
  aliases: [],
  verifiedDomains: [],
  claimStatus: 'unclaimed',
  status: 'active',
  mergedIntoAccountId: null,
  createdAt: '2022-01-01T00:00:00Z',
  updatedAt: '2022-01-01T00:00:00Z',
};
let renderer: ReactTestRenderer;
let client: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function render(element: React.ReactElement) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>{element}</QueryClientProvider>,
    );
  });
  await settle();
}
const rendered = () => JSON.stringify(renderer.toJSON());
function button(label: string) {
  return renderer.root.findAllByType('button').find((node) => node.props.children === label);
}
function input(label: string) {
  return renderer.root.findAllByType('input').find((node) => node.props.label === label)!;
}
async function press(label: string) {
  await act(async () => {
    button(label)!.props.onPress();
  });
  await settle();
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockSupervision, { ready: true, supervised: false, isError: false });
  mockAuth.user = { id: 'person' };
  mockAuth.isAuthenticated = true;
  mockAuth.canUsePrivateApi = true;
  mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(0);
  jest.mocked(experienceService.list).mockResolvedValue([entry]);
  jest.mocked(experienceService.create).mockResolvedValue(entry);
  jest.mocked(experienceService.update).mockResolvedValue(entry);
  jest.mocked(experienceService.remove).mockResolvedValue();
  mockAuth.oxyServices.safety.organizations.mockResolvedValue({
    items: [
      {
        requestedAccountId: organization.accountId,
        organization: {
          accountId: organization.accountId,
          username: organization.username,
          name: organization.name,
          organizationType: organization.organizationType,
        },
      },
    ],
    missingIds: [],
  });
  mockAuth.oxyServices.organizations.batch.mockResolvedValue({
    items: [{ requestedAccountId: 'org-apple', organization }],
    missingIds: [],
  });
  mockAuth.oxyServices.organizations.search.mockResolvedValue({
    items: [organization],
    nextCursor: null,
  });
  mockAuth.oxyServices.organizations.create.mockResolvedValue({
    ...organization,
    accountId: 'org-new',
    name: 'Example',
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  client?.clear();
});

describe('experience visibility and editing', () => {
  it('shows public career history without owner controls to another viewer', async () => {
    mockAuth.user = { id: 'visitor' };
    await render(<ProfileExperience profileId="person" isOwnProfile={false} />);
    await waitUntil(() => rendered().includes('Designer'), 'the role');
    expect(experienceService.list).toHaveBeenCalledWith('person', true);
    expect(button('Add experience')).toBeUndefined();
    expect(button('Edit')).toBeUndefined();
  });

  it('withholds owner controls while the private API session is restoring', async () => {
    mockAuth.canUsePrivateApi = false;
    await render(<ProfileExperience profileId="person" isOwnProfile />);
    expect(button('Add experience')).toBeUndefined();
    expect(experienceService.list).not.toHaveBeenCalled();
  });

  it('distinguishes a read failure from empty history and retries', async () => {
    jest.mocked(experienceService.list).mockRejectedValueOnce(new Error('offline'));
    await render(<ProfileExperience profileId="person" isOwnProfile={false} />);
    await waitUntil(() => rendered().includes('Experience could not be loaded'), 'the read error');
    await press('Try again');
    await waitUntil(() => rendered().includes('Designer'), 'the role after retrying');
  });

  it('validates required fields and date order before creating a role', async () => {
    const onSaved = jest.fn();
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={onSaved} />);
    await press('Save');
    expect(experienceService.create).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Enter a title');
    act(() => {
      input('Title *').props.onChangeText('Engineer');
      input('Company or organization *').props.onChangeText('Apple');
      input('Start date *').props.onChangeText('2023-02');
      renderer.root.find((node) => node.type === 'switch').props.onCheckedChange(false);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    const apple = () =>
      renderer.root.findAll((node) => String(node.type) === 'item' && node.props.title === 'Apple');
    await waitUntil(() => apple().length > 0, 'Apple in the employer search');
    act(() => apple()[0].props.onPress());
    act(() => input('End date *').props.onChangeText('2022-10'));
    await press('Save');
    expect(experienceService.create).not.toHaveBeenCalled();
    act(() => input('End date *').props.onChangeText('2024-10'));
    await press('Save');
    await waitUntil(() => onSaved.mock.calls.length > 0, 'the saved role');
    expect(experienceService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Engineer',
        employerOxyAccountId: 'org-apple',
        startDate: '2023-02',
        endDate: '2024-10',
      }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('updates the canonical role and reloads the owner list after saving', async () => {
    await render(<ProfileExperience profileId="person" isOwnProfile />);
    await waitUntil(() => button('Edit') !== undefined, 'the Edit button');
    await press('Edit');
    act(() => input('Title *').props.onChangeText('Lead Designer'));
    await press('Save');
    await waitUntil(
      () => jest.mocked(experienceService.list).mock.calls.length === 2,
      'the list reloaded after saving',
    );
    await waitUntil(() => renderer.root.findAllByType('dialog').length === 0, 'the editor closed');
    expect(experienceService.update).toHaveBeenCalledWith(
      'role',
      expect.objectContaining({ title: 'Lead Designer' }),
    );
    expect(experienceService.list).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByType('dialog')).toHaveLength(0);
  });

  it('preserves an unsuccessful edit so it can be retried', async () => {
    jest.mocked(experienceService.update).mockRejectedValueOnce(new Error('offline'));
    const onSaved = jest.fn();
    await render(
      <ExperienceEditor
        entry={entry}
        employer={organization}
        ownerId="person"
        onClose={jest.fn()}
        onSaved={onSaved}
      />,
    );
    const alerts = () =>
      renderer.root
        .findAll((node) => node.props.accessibilityRole === 'alert')
        .some((node) => String(node.props.children).includes('Your changes could not be saved'));
    act(() => input('Title *').props.onChangeText('Lead Designer'));
    await press('Save');
    await waitUntil(alerts, 'the save error');
    expect(input('Title *').props.value).toBe('Lead Designer');
    expect(onSaved).not.toHaveBeenCalled();
    await press('Save');
    await waitUntil(() => onSaved.mock.calls.length > 0, 'the retried save');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not resume a queued save in a different session', async () => {
    onlineManager.setOnline(false);
    try {
      await render(
        <ExperienceEditor
          entry={entry}
          employer={organization}
          ownerId="person"
          onClose={jest.fn()}
          onSaved={jest.fn()}
        />,
      );
      await press('Save');
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(true);
      mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(1);
      await act(async () => {
        onlineManager.setOnline(true);
        await client.resumePausedMutations();
      });
      expect(experienceService.update).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('does not start a retained save or deletion after the session changes', async () => {
    await render(
      <ExperienceEditor
        entry={entry}
        employer={organization}
        ownerId="person"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );
    mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(1);
    await press('Save');
    await press('Delete');
    expect(experienceService.update).not.toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('does not call the saved callback after a session change', async () => {
    let finish!: (value: Experience) => void;
    jest
      .mocked(experienceService.update)
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const onSaved = jest.fn();
    await render(
      <ExperienceEditor
        entry={entry}
        employer={organization}
        ownerId="person"
        onClose={jest.fn()}
        onSaved={onSaved}
      />,
    );
    await press('Save');
    expect(experienceService.update).toHaveBeenCalledTimes(1);
    mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(1);
    await act(async () => finish(entry));
    await settle();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('only deletes a role after confirmation', async () => {
    const onSaved = jest.fn();
    jest.mocked(confirmDialog).mockResolvedValueOnce(false);
    await render(
      <ExperienceEditor
        entry={entry}
        employer={organization}
        ownerId="person"
        onClose={jest.fn()}
        onSaved={onSaved}
      />,
    );
    await press('Delete');
    await waitUntil(() => jest.mocked(confirmDialog).mock.calls.length === 1, 'the confirmation');
    expect(experienceService.remove).not.toHaveBeenCalled();
    await press('Delete');
    await waitUntil(() => onSaved.mock.calls.length > 0, 'the deletion');
    expect(experienceService.remove).toHaveBeenCalledWith('role');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not delete when the session changes while confirmation is open', async () => {
    let confirm!: (value: boolean) => void;
    jest.mocked(confirmDialog).mockReturnValueOnce(new Promise((resolve) => (confirm = resolve)));
    await render(
      <ExperienceEditor
        entry={entry}
        employer={organization}
        ownerId="person"
        onClose={jest.fn()}
        onSaved={jest.fn()}
      />,
    );
    await press('Delete');
    mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(1);
    mockAuth.user = { id: 'another-person' };
    await act(async () => {
      renderer.unmount();
      confirm(true);
    });
    await settle();
    expect(experienceService.remove).not.toHaveBeenCalled();
  });

  it('does not resume a queued deletion in a different session', async () => {
    onlineManager.setOnline(false);
    try {
      await render(
        <ExperienceEditor
          entry={entry}
          employer={organization}
          ownerId="person"
          onClose={jest.fn()}
          onSaved={jest.fn()}
        />,
      );
      await press('Delete');
      expect(experienceService.remove).not.toHaveBeenCalled();
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(true);
      mockAuth.oxyServices.http.getSessionEpoch.mockReturnValue(1);
      await act(async () => {
        onlineManager.setOnline(true);
        await client.resumePausedMutations();
      });
      expect(experienceService.remove).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

describe('central employer identity', () => {
  it('hydrates each distinct employer once in one directory batch, including repeated tenures', async () => {
    jest
      .mocked(experienceService.list)
      .mockResolvedValue([
        entry,
        { ...entry, id: 'earlier', startDate: '2010-01', endDate: '2020-01' },
      ]);
    await render(<ProfileExperience profileId="person" isOwnProfile={false} />);
    await waitUntil(() => rendered().includes('Apple'), 'the employer name');
    expect(mockAuth.oxyServices.organizations.batch).toHaveBeenCalledTimes(1);
    expect(mockAuth.oxyServices.organizations.batch).toHaveBeenCalledWith({ ids: ['org-apple'] });
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'profile-link')
        .every((node) => node.props.href === '/@apple'),
    ).toBe(true);
  });

  it('preserves career history when an employer is unavailable without exposing a saved name', async () => {
    mockAuth.oxyServices.safety.organizations.mockResolvedValue({
      items: [
        {
          requestedAccountId: organization.accountId,
          organization: {
            accountId: organization.accountId,
            username: organization.username,
            name: organization.name,
            organizationType: organization.organizationType,
          },
        },
      ],
      missingIds: [],
    });
    mockAuth.oxyServices.organizations.batch.mockResolvedValue({
      items: [],
      missingIds: ['org-apple'],
    });
    await render(<ProfileExperience profileId="person" isOwnProfile={false} />);
    await waitUntil(
      () => rendered().includes('Organization unavailable'),
      'the unavailable employer',
    );
    expect(rendered()).toContain('Designer');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Apple');
  });

  it('creates a neutral directory organization and submits only its canonical ID', async () => {
    mockAuth.oxyServices.organizations.search.mockResolvedValue({ items: [], nextCursor: null });
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={jest.fn()} />);
    act(() => {
      input('Title *').props.onChangeText('Engineer');
      input('Start date *').props.onChangeText('2024-01');
      input('Company or organization *').props.onChangeText(' Example ');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitUntil(() => button('Organization missing? Add it') !== undefined, 'the add offer');
    await press('Organization missing? Add it');
    await waitUntil(() => rendered().includes('does not grant you ownership'), 'the add form');
    act(() => {
      input('Website (optional)').props.onChangeText(' https://example.com ');
      input('Country code (optional, e.g. US)').props.onChangeText('gb');
    });
    await press('Add to directory');
    await waitUntil(
      () => mockAuth.oxyServices.organizations.create.mock.calls.length > 0,
      'the directory create',
    );
    expect(mockAuth.oxyServices.organizations.create).toHaveBeenCalledWith({
      name: 'Example',
      organizationType: 'business',
      websiteUrl: 'https://example.com',
      countryCode: 'GB',
    });
    await press('Save');
    await waitUntil(
      () => jest.mocked(experienceService.create).mock.calls.length > 0,
      'the role create',
    );
    expect(experienceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ employerOxyAccountId: 'org-new' }),
    );
    const submitted = jest.mocked(experienceService.create).mock.calls[0][0];
    expect(submitted).not.toHaveProperty('companyName');
    expect(submitted).not.toHaveProperty('companyOxyUserId');
  });

  it('rejects an invalid website without creating an organization', async () => {
    mockAuth.oxyServices.organizations.search.mockResolvedValue({ items: [], nextCursor: null });
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={jest.fn()} />);
    act(() => input('Company or organization *').props.onChangeText('Example'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitUntil(() => button('Organization missing? Add it') !== undefined, 'the add offer');
    await press('Organization missing? Add it');
    act(() => input('Website (optional)').props.onChangeText('not a URL'));
    await press('Add to directory');
    expect(rendered()).toContain('Check the name, website URL and two-letter country code.');
    expect(mockAuth.oxyServices.organizations.create).not.toHaveBeenCalled();
  });

  it('does not offer directory creation during a search outage', async () => {
    mockAuth.oxyServices.organizations.search.mockRejectedValue(new Error('offline'));
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={jest.fn()} />);
    act(() => input('Company or organization *').props.onChangeText('Example'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitUntil(() => button('Try again') !== undefined, 'the search error');
    expect(button('Organization missing? Add it')).toBeUndefined();
  });
});

it('withholds unrated history until current supervision permits it and hides cached content on revocation', async () => {
  const element = () => (
    <SupervisedFeatureGate>
      <ProfileExperience profileId="person" isOwnProfile />
    </SupervisedFeatureGate>
  );
  mockSupervision.ready = false;
  await render(element());
  expect(experienceService.list).not.toHaveBeenCalled();
  expect(mockAuth.oxyServices.organizations.batch).not.toHaveBeenCalled();
  mockSupervision.ready = true;
  await act(async () => {
    renderer.update(<QueryClientProvider client={client}>{element()}</QueryClientProvider>);
  });
  await waitUntil(() => rendered().includes('Designer'), 'the role once supervision permits it');
  expect(button('Add experience')).toBeDefined();
  mockSupervision.supervised = true;
  await act(async () => {
    renderer.update(<QueryClientProvider client={client}>{element()}</QueryClientProvider>);
  });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Designer');
  expect(button('Add experience')).toBeUndefined();
  expect(renderer.root.findByType(EmptyState).props.title).toBe('Unavailable for this account');
  mockSupervision.isError = true;
  await act(async () => {
    renderer.update(<QueryClientProvider client={client}>{element()}</QueryClientProvider>);
  });
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Designer');
  expect(renderer.root.findByType(EmptyState).props.error.title).toBe(
    'Could not check account availability',
  );
});

it('manages its own roles using minimal employer identities and never loads the public directory', async () => {
  mockSupervision.supervised = true;
  await render(
    <SupervisedFeatureGate allowSupervised>
      <ProfileExperience profileId="person" isOwnProfile />
    </SupervisedFeatureGate>,
  );
  await waitUntil(() => rendered().includes('Apple'), 'the minimal employer identity');
  expect(rendered()).toContain('Designer');
  expect(mockAuth.oxyServices.safety.organizations).toHaveBeenCalledWith({ ids: ['org-apple'] });
  expect(mockAuth.oxyServices.organizations.batch).not.toHaveBeenCalled();
  expect(renderer.root.findAllByType(Avatar).every((avatar) => !avatar.props.source)).toBe(true);
  await press('Add experience');
  await act(async () => {
    input('Company or organization *').props.onChangeText('Apple');
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 330));
  });
  const companies = () =>
    renderer.root
      .findAllByType(Item)
      .filter((item) => item.props.onPress && item.props.title === 'Apple');
  await waitUntil(() => companies().length > 0, 'Apple in the minimal search');
  expect(mockAuth.oxyServices.safety.organizations).toHaveBeenCalledWith({
    query: 'Apple',
    limit: 20,
  });
  expect(mockAuth.oxyServices.organizations.search).not.toHaveBeenCalled();
  expect(button('Organization missing? Add it')).toBeUndefined();
  expect(renderer.root.findAllByType(Item).every((item) => !item.props.subtitle)).toBe(true);
  await act(async () => {
    companies()[0].props.onPress();
  });
  await act(async () => {
    input('Title *').props.onChangeText('Researcher');
    input('Start date *').props.onChangeText('2024-01');
  });
  await press('Save');
  await waitUntil(
    () => jest.mocked(experienceService.create).mock.calls.length > 0,
    'the role create',
  );
  expect(experienceService.create).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'Researcher', employerOxyAccountId: 'org-apple' }),
  );
  expect(mockAuth.oxyServices.organizations.create).not.toHaveBeenCalled();
});
