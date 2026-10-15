import type React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Experience } from '@clarity.surf/sdk/experience';

const mockAuth = {
  user: { id: 'person' },
  isAuthenticated: true,
  canUsePrivateApi: true,
  oxyServices: { organizations: { batch: jest.fn(), search: jest.fn(), create: jest.fn() } },
};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@/hooks/useCachedUser', () => ({ useCachedUserSnapshot: () => undefined }));
jest.mock('@/utils/userEnrichment', () => ({
  prewarmUsersByIds: jest.fn(() => Promise.resolve([])),
}));
jest.mock('@/context/ScreenReselectContext', () => ({ useScreenReselect: () => {} }));
jest.mock('expo-router', () => ({ Link: 'profile-link' }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: 'avatar' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'button' }));
jest.mock('@oxy.so/bloom/loading', () => ({ Loading: 'loading' }));
jest.mock('@oxy.so/bloom/item', () => ({ Item: 'item' }));
jest.mock('@oxy.so/bloom/dialog', () => ({ Dialog: 'dialog', useDialogControl: () => require('react').useMemo(() => ({ open: jest.fn(), close: (callback?: () => void) => callback?.() }), []) }));
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
  mockAuth.user = { id: 'person' };
  mockAuth.isAuthenticated = true;
  mockAuth.canUsePrivateApi = true;
  jest.mocked(experienceService.list).mockResolvedValue([entry]);
  jest.mocked(experienceService.create).mockResolvedValue(entry);
  jest.mocked(experienceService.update).mockResolvedValue(entry);
  jest.mocked(experienceService.remove).mockResolvedValue();
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
    expect(experienceService.list).toHaveBeenCalledWith('person', true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Designer');
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
    expect(JSON.stringify(renderer.toJSON())).toContain('Experience could not be loaded');
    await press('Try again');
    expect(JSON.stringify(renderer.toJSON())).toContain('Designer');
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
    await settle();
    act(() =>
      renderer.root
        .findAll((node) => String(node.type) === 'item' && node.props.title === 'Apple')[0]
        .props.onPress(),
    );
    act(() => input('End date *').props.onChangeText('2022-10'));
    await press('Save');
    expect(experienceService.create).not.toHaveBeenCalled();
    act(() => input('End date *').props.onChangeText('2024-10'));
    await press('Save');
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
    await press('Edit');
    act(() => input('Title *').props.onChangeText('Lead Designer'));
    await press('Save');
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
    act(() => input('Title *').props.onChangeText('Lead Designer'));
    await press('Save');
    expect(input('Title *').props.value).toBe('Lead Designer');
    expect(onSaved).not.toHaveBeenCalled();
    expect(
      renderer.root
        .findAll((node) => node.props.accessibilityRole === 'alert')
        .some((node) => String(node.props.children).includes('Your changes could not be saved')),
    ).toBe(true);
    await press('Save');
    expect(onSaved).toHaveBeenCalledTimes(1);
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
    expect(experienceService.remove).not.toHaveBeenCalled();
    await press('Delete');
    expect(experienceService.remove).toHaveBeenCalledWith('role');
    expect(onSaved).toHaveBeenCalledTimes(1);
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
    await settle();
    expect(mockAuth.oxyServices.organizations.batch).toHaveBeenCalledTimes(1);
    expect(mockAuth.oxyServices.organizations.batch).toHaveBeenCalledWith({ ids: ['org-apple'] });
    expect(JSON.stringify(renderer.toJSON())).toContain('Apple');
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'profile-link')
        .every((node) => node.props.href === '/@apple'),
    ).toBe(true);
  });

  it('preserves career history when an employer is unavailable without exposing a saved name', async () => {
    mockAuth.oxyServices.organizations.batch.mockResolvedValue({
      items: [],
      missingIds: ['org-apple'],
    });
    await render(<ProfileExperience profileId="person" isOwnProfile={false} />);
    await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('Designer');
    expect(JSON.stringify(renderer.toJSON())).toContain('Organization unavailable');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Apple');
  });

  it('creates a neutral directory organization and submits only its canonical ID', async () => {
    mockAuth.oxyServices.organizations.search.mockResolvedValue({ items: [], nextCursor: null });
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={jest.fn()} />);
    act(() => {
      input('Title *').props.onChangeText('Engineer');
      input('Start date *').props.onChangeText('2024-01');
      input('Company or organization *').props.onChangeText('Example');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await settle();
    await press('Organization missing? Add it');
    expect(JSON.stringify(renderer.toJSON())).toContain('does not grant you ownership');
    act(() => {
      input('Website (optional)').props.onChangeText('https://example.com');
      input('Country code (optional, e.g. US)').props.onChangeText('GB');
    });
    await press('Add to directory');
    expect(mockAuth.oxyServices.organizations.create).toHaveBeenCalledWith({
      name: 'Example',
      organizationType: 'business',
      websiteUrl: 'https://example.com',
      countryCode: 'GB',
    });
    await press('Save');
    expect(experienceService.create).toHaveBeenCalledWith(
      expect.objectContaining({ employerOxyAccountId: 'org-new' }),
    );
    const submitted = jest.mocked(experienceService.create).mock.calls[0][0];
    expect(submitted).not.toHaveProperty('companyName');
    expect(submitted).not.toHaveProperty('companyOxyUserId');
  });

  it('does not offer directory creation during a search outage', async () => {
    mockAuth.oxyServices.organizations.search.mockRejectedValue(new Error('offline'));
    await render(<ExperienceEditor ownerId="person" onClose={jest.fn()} onSaved={jest.fn()} />);
    act(() => input('Company or organization *').props.onChangeText('Example'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await settle();
    expect(button('Organization missing? Add it')).toBeUndefined();
    expect(button('Try again')).toBeDefined();
  });
});
