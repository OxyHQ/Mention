import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Draft } from '@/hooks/useDrafts';
import type { DraftListItem } from '@/hooks/useDraftsList';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';
import DraftsList from '../DraftsList';

/**
 * The drafts screen: ONE list over drafts that live in two places.
 *
 * What it must get right, none of which is visible from reading the row:
 *
 *  1. Both kinds render with the same row, in the order `useDraftsList` gives
 *     them, and ONLY a device draft says "On this device".
 *  2. The buttons go where the draft lives. A device draft deletes from storage
 *     and loads into the composer; an account draft deletes through the API,
 *     opens on the composer's edit route, and can be published — a one-way,
 *     public write whose confirm step is asserted in both directions.
 *  3. A failed server read reports itself beside the device drafts instead of
 *     hiding them behind an error.
 */

const mockConfirm = jest.fn();
const mockToast = jest.fn();

const mockList: {
  items: DraftListItem[];
  isLoading: boolean;
  serverLoading: boolean;
  serverError: boolean;
  refetchServerDrafts: jest.Mock;
  publishServerDraft: jest.Mock;
  deleteServerDraft: jest.Mock;
  deleteDeviceDraft: jest.Mock;
  viewerId?: string;
} = {
  items: [],
  isLoading: false,
  serverLoading: false,
  serverError: false,
  refetchServerDrafts: jest.fn(),
  publishServerDraft: jest.fn(),
  deleteServerDraft: jest.fn(),
  deleteDeviceDraft: jest.fn(),
  viewerId: 'viewer-1',
};

jest.mock('@/hooks/useDraftsList', () => ({ useDraftsList: () => mockList }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; languages?: string }) =>
      (options?.defaultValue ?? key).replace('{{languages}}', options?.languages ?? ''),
    i18n: { language: 'en-US' },
  }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({
    colors: {
      border: '#333',
      card: '#fff',
      primary: '#7c3aed',
      text: '#000',
      textSecondary: '#666',
      textTertiary: '#999',
    },
  }),
}));

jest.mock('@oxy.so/bloom/loading', () => ({ Loading: () => null }));
jest.mock('@oxy.so/bloom/button', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return { Button: TouchableOpacity };
});
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: (...args: unknown[]) => mockConfirm(...args) }));
jest.mock('@/assets/icons/drafts', () => ({ DraftsIcon: () => null }));
jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user?: { username?: string }) => user?.username,
}));
jest.mock('@/utils/postLanguages', () => ({
  languageLabel: (tag: string) => ({ es: 'Español', fr: 'Français' }[tag] ?? tag),
}));

const NOW = Date.now();

/** An account draft an automation wrote in English and Spanish. */
function serverItem(): DraftListItem {
  const post = scheduledPostFixture({
    id: 'server-draft-1',
    content: {
      text: 'Release notes for 4.2',
      textLang: 'en',
      variants: [
        { source: 'author', tag: 'en', text: 'Release notes for 4.2' },
        { source: 'author', tag: 'es', text: 'Notas de la versión 4.2' },
        // A machine rendition is not something the author wrote in.
        { source: 'machine', tag: 'fr', text: 'Notes de version 4.2' },
      ],
    },
  });
  return { origin: 'server', id: post.id, updatedAt: NOW - 60_000, post };
}

function deviceItem(): DraftListItem {
  const draft: Draft = {
    id: 'device-draft-1',
    postContent: 'Half a thought',
    mediaIds: [],
    pollOptions: [],
    showPollCreator: false,
    location: null,
    threadItems: [],
    mentions: [],
    postingMode: 'thread',
    createdAt: NOW - 120_000,
    updatedAt: NOW - 120_000,
  };
  return { origin: 'device', id: draft.id, updatedAt: draft.updatedAt, draft };
}

function renderList(overrides: Partial<React.ComponentProps<typeof DraftsList>> = {}) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <DraftsList
        onLoadDraft={() => {}}
        onPreviewDraft={() => {}}
        currentDraftId={null}
        onPreviewServerDraft={() => {}}
        onEditServerDraft={() => {}}
        {...overrides}
      />,
    );
  });
  if (!tree) throw new Error('DraftsList failed to render');
  return tree;
}

function textContent(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap((node) => node.props.children)
    .filter((child): child is string | number =>
      typeof child === 'string' || typeof child === 'number')
    .map(String)
    .join(' | ');
}

/** The Nth button carrying this label, in render (= list) order. */
function press(tree: TestRenderer.ReactTestRenderer, label: string, index = 0) {
  // By the touchable's own type: the layers it renders carry the same props,
  // and counting them would make every second index the same button.
  const buttons = tree.root
    .findAllByType(TouchableOpacity)
    .filter((node) => node.props.accessibilityLabel === label);
  const button = buttons[index];
  if (!button) throw new Error(`No button "${label}" at ${index}`);
  act(() => {
    button.props.onPress();
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('DraftsList', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockList.items = [serverItem(), deviceItem()];
    mockList.isLoading = false;
    mockList.serverLoading = false;
    mockList.serverError = false;
    mockList.publishServerDraft.mockResolvedValue(undefined);
    mockList.deleteServerDraft.mockResolvedValue(undefined);
    mockList.deleteDeviceDraft.mockResolvedValue(undefined);
  });

  it('renders both kinds in one list, in the order given, marking only the device draft', () => {
    const tree = renderList();
    const rendered = textContent(tree);

    expect(rendered.indexOf('Release notes for 4.2')).toBeLessThan(rendered.indexOf('Half a thought'));
    // Exactly one hint, and it belongs to the device row: it follows the server
    // row's text and precedes the device row's.
    expect(rendered.split('On this device')).toHaveLength(2);
    expect(rendered.indexOf('On this device')).toBeGreaterThan(rendered.indexOf('Release notes for 4.2'));
    // Only the author's other language, not the machine translation.
    expect(rendered).toContain('Also in Español');
    expect(rendered).not.toContain('Français');

    act(() => tree.unmount());
  });

  it('offers Publish on the account draft only', () => {
    const tree = renderList();

    const publishButtons = tree.root
      .findAllByType(TouchableOpacity)
      .filter((node) => node.props.accessibilityLabel === 'Publish draft');
    expect(publishButtons).toHaveLength(1);

    act(() => tree.unmount());
  });

  it('publishes the confirmed account draft and says so', async () => {
    const tree = renderList();

    press(tree, 'Publish draft');
    await flush();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockList.publishServerDraft).toHaveBeenCalledWith('server-draft-1');
    expect(mockToast).toHaveBeenCalledWith('Draft published', { type: 'success' });

    act(() => tree.unmount());
  });

  it('publishes nothing when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false);
    const tree = renderList();

    press(tree, 'Publish draft');
    await flush();

    expect(mockList.publishServerDraft).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('reports a refused publish instead of pretending it went out', async () => {
    mockList.publishServerDraft.mockRejectedValue(new Error('409 from the API'));
    const tree = renderList();

    press(tree, 'Publish draft');
    await flush();

    expect(mockToast).toHaveBeenCalledWith('Could not publish the draft', { type: 'error' });

    act(() => tree.unmount());
  });

  it('deletes each draft where it lives', async () => {
    const tree = renderList();

    press(tree, 'compose.deleteDraft', 0);
    await flush();
    expect(mockList.deleteServerDraft).toHaveBeenCalledWith('server-draft-1');
    expect(mockList.deleteDeviceDraft).not.toHaveBeenCalled();

    press(tree, 'compose.deleteDraft', 1);
    await flush();
    expect(mockList.deleteDeviceDraft).toHaveBeenCalledWith('device-draft-1');
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));

    act(() => tree.unmount());
  });

  it('opens each draft where it can be edited: the edit route, or the composer loader', async () => {
    const onEditServerDraft = jest.fn();
    const onLoadDraft = jest.fn();
    const tree = renderList({ onEditServerDraft, onLoadDraft });

    press(tree, 'Continue writing', 0);
    press(tree, 'Continue writing', 1);
    await flush();

    expect(onEditServerDraft.mock.calls[0][0].id).toBe('server-draft-1');
    expect(onLoadDraft.mock.calls[0][0].id).toBe('device-draft-1');
    expect(mockConfirm).not.toHaveBeenCalled();

    act(() => tree.unmount());
  });

  it('previews each draft through its own preview', async () => {
    const onPreviewServerDraft = jest.fn();
    const onPreviewDraft = jest.fn();
    const tree = renderList({ onPreviewServerDraft, onPreviewDraft });

    press(tree, 'Preview draft', 0);
    press(tree, 'Preview draft', 1);
    await flush();

    expect(onPreviewServerDraft.mock.calls[0][0].id).toBe('server-draft-1');
    expect(onPreviewDraft.mock.calls[0][0].id).toBe('device-draft-1');

    act(() => tree.unmount());
  });

  it('keeps the device drafts on screen when the account drafts fail to load', () => {
    mockList.items = [deviceItem()];
    mockList.serverError = true;
    const tree = renderList();
    const rendered = textContent(tree);

    expect(rendered).toContain("We couldn't load the drafts saved to your account");
    expect(rendered).toContain('Half a thought');

    const retry = tree.root.find((node) => node.props.onPress === mockList.refetchServerDrafts);
    act(() => {
      retry.props.onPress();
    });
    expect(mockList.refetchServerDrafts).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  it('shows the empty state only when there is nothing anywhere', () => {
    mockList.items = [];
    const tree = renderList();

    expect(textContent(tree)).toContain('compose.noDrafts');

    act(() => tree.unmount());
  });
});
