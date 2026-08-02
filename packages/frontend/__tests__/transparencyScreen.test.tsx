import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import type { PublishedFederationBlock } from '@mention/shared-types';
import enMessages from '@/locales/en.json';

// `jest.mock` calls are hoisted above this import, so the screen loads with
// every module boundary below already swapped for its test double.
import TransparencyScreen from '@/app/(app)/transparency';

/**
 * The public moderation transparency page.
 *
 * The backend half of the invariant — that the list this page is served is
 * exactly the list the server enforces — is proved in the backend's
 * `connectors/federationTransparency.test.ts`. This file holds up the FRONT half:
 * that the page renders what it was served, whole and with the reason attached.
 *
 * Two failures would each turn the page into a lie while everything still looked
 * fine, so both are asserted directly:
 *   - dropping or truncating rows, so a real block is enforced but not shown;
 *   - inventing a reason for an urgent operational block that has none yet.
 */

// ── Module boundaries ───────────────────────────────────────────────────────

type MessageNode = string | number | boolean | null | MessageNode[] | { [key: string]: MessageNode };

const messages: { [key: string]: MessageNode } = enMessages;

function lookup(key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<MessageNode | undefined>(
      (node, part) =>
        typeof node === 'object' && node !== null && !Array.isArray(node) ? node[part] : undefined,
      messages,
    );
  return typeof value === 'string' ? value : undefined;
}

/**
 * `t` resolves against the REAL `en.json`, including i18next's `_one`/`_other`
 * plural suffixes. Copy that never made it into the catalog therefore renders as
 * its raw key here and fails the assertion, rather than shipping
 * "transparency.list.empty" to a reader.
 */
function mockTranslate(key: string, vars?: Record<string, string | number>): string {
  const count = typeof vars?.count === 'number' ? vars.count : undefined;
  const candidates =
    count === undefined ? [key] : [`${key}_${count === 1 ? 'one' : 'other'}`, key];
  const template = candidates.map(lookup).find((value) => value !== undefined);
  if (template === undefined) return key;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ''));
}

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}));

const mockPublicGet = jest.fn();
jest.mock('@/utils/api', () => ({
  publicApi: { get: (...args: unknown[]) => mockPublicGet(...args) },
}));

jest.mock('@/components/Header', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Header: () => <RNView testID="header" /> };
});

jest.mock('@/components/ui/Button', () => {
  const { TouchableOpacity: RNTouchable } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    IconButton: ({ children }: { children?: React.ReactNode }) => (
      <RNTouchable>{children}</RNTouchable>
    ),
  };
});

jest.mock('@/assets/icons/back-arrow-icon', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { BackArrowIcon: () => <RNView testID="back-arrow" /> };
});

jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));

jest.mock('@oxyhq/bloom/loading', () => {
  const { View: RNView } = jest.requireActual<typeof import('react-native')>('react-native');
  return { Loading: () => <RNView testID="loading" /> };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const DOCUMENTED_BLOCK: PublishedFederationBlock = {
  source: 'policy',
  domain: 'spam-farm.invalid',
  severity: 'suspend',
  category: 'spam',
  reason: 'Bulk automated posting into unrelated conversations.',
  since: '2026-08-02',
  corroboratingSources: ['mastodon.social', 'mstdn.social'],
};

const UNCORROBORATED_BLOCK: PublishedFederationBlock = {
  source: 'policy',
  domain: 'reported-here.invalid',
  severity: 'suspend',
  category: 'harassment',
  reason: 'Coordinated harassment directed at people on this server.',
  since: '2026-07-30',
  corroboratingSources: [],
};

const OPERATIONAL_BLOCK: PublishedFederationBlock = {
  source: 'operational',
  domain: 'urgent.invalid',
  severity: 'suspend',
};

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * React Query batches subscriber notifications on a timer by default, landing
 * renders outside `act`. Notify synchronously so a settled query is on screen the
 * moment the awaited work resolves.
 */
notifyManager.setScheduler((callback) => callback());

async function renderScreen(): Promise<ReactTestInstance> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <TransparencyScreen />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer.root;
}

/** Every string the screen actually put on the page. */
function renderedTexts(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .flatMap((node) => {
      const children = node.props.children;
      return Array.isArray(children) ? children : [children];
    })
    .filter((child): child is string => typeof child === 'string');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('transparency page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the public endpoint, with no authentication', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [] } });

    await renderScreen();

    // The audience for a moderation statement is largely people who are not
    // signed in, so this must go through the unauthenticated client.
    expect(mockPublicGet).toHaveBeenCalledWith('/federation/blocked-domains');
  });

  it('shows a documented block with its reason, category, date and corroboration', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [DOCUMENTED_BLOCK] } });

    const texts = renderedTexts(await renderScreen());

    expect(texts).toContain('spam-farm.invalid');
    expect(texts).toContain('Bulk automated posting into unrelated conversations.');
    expect(texts).toContain('Spam · Blocked since 2026-08-02');
    expect(texts).toContain('Also published by mastodon.social, mstdn.social');
    expect(texts).toContain('1 instance is blocked.');
  });

  it('says a block was decided here when nobody else published it', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [UNCORROBORATED_BLOCK] } });

    const texts = renderedTexts(await renderScreen());

    // Silence about corroboration would let a reader assume it, so the absence
    // is stated rather than left blank.
    expect(texts).toContain('Decided from reports and moderation on Mention.');
    expect(texts).toContain('Targeted harassment · Blocked since 2026-07-30');
    expect(texts.some((text) => text.startsWith('Also published by'))).toBe(false);
  });

  it('admits an urgent block has no published reason instead of inventing one', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [OPERATIONAL_BLOCK] } });

    const texts = renderedTexts(await renderScreen());

    expect(texts).toContain('urgent.invalid');
    expect(texts).toContain(
      'Blocked urgently by an operator, ahead of a written policy entry. Its reason has not been published yet.',
    );
    expect(texts.some((text) => text.startsWith('Also published by'))).toBe(false);
    expect(texts.some((text) => text.includes('Blocked since'))).toBe(false);
  });

  it('renders every domain the server published, never a truncated view of it', async () => {
    // The page and the enforcement must describe the same set. A page that
    // dropped or capped rows would show fewer instances than are actually
    // refused — the exact drift this surface exists to prevent, and invisible
    // unless the count is asserted.
    const many: PublishedFederationBlock[] = Array.from({ length: 12 }, (_, index) => ({
      source: 'policy',
      domain: `instance-${index}.invalid`,
      severity: 'suspend',
      category: 'hate_speech',
      reason: `Reason number ${index}.`,
      since: '2026-08-02',
      corroboratingSources: [],
    }));
    mockPublicGet.mockResolvedValue({ data: { blocks: many } });

    const texts = renderedTexts(await renderScreen());

    for (const block of many) {
      expect(texts).toContain(block.domain);
    }
    expect(texts).toContain('12 instances are blocked.');
  });

  it('states plainly that nothing is blocked rather than showing a bare empty page', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [] } });

    const texts = renderedTexts(await renderScreen());

    expect(texts).toContain(
      'No instances are blocked. Mention federates with the whole network today; if that changes, every decision will appear here with its reason and the date it took effect.',
    );
    expect(texts.some((text) => text.includes('instance is blocked'))).toBe(false);
  });

  it('points at the raw endpoint when the list cannot be loaded', async () => {
    mockPublicGet.mockRejectedValue(new Error('offline'));

    const texts = renderedTexts(await renderScreen());

    // A failed fetch must not read as "no instances are blocked".
    expect(texts).toContain(
      'This list could not be loaded right now. It is served at /federation/blocked-domains if you would rather read it directly.',
    );
    expect(texts.some((text) => text.startsWith('No instances are blocked'))).toBe(false);
  });

  it('always explains what a block does and how it was decided', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [] } });

    const texts = renderedTexts(await renderScreen());

    // The list is the smaller half of the page. Naming domains without saying
    // what a block means, what it does not cover, and on what basis it was taken
    // is not transparency.
    expect(texts).toContain(lookup('transparency.whatItDoes.body'));
    expect(texts).toContain(lookup('transparency.whatItDoes.limits'));
    expect(texts).toContain(lookup('transparency.howWeDecide.corroboration'));
    expect(texts).toContain(lookup('transparency.howWeDecide.judgement'));
    expect(texts).toContain(lookup('transparency.howWeDecide.audit'));
  });

  it('says that a block covers the exact server named, and not its subdomains', async () => {
    mockPublicGet.mockResolvedValue({ data: { blocks: [DOCUMENTED_BLOCK] } });

    const texts = renderedTexts(await renderScreen());
    const scope = lookup('transparency.whatItDoes.scope');

    // `isBlockedDomain` is exact set membership on the canonical host: blocking
    // one server does not block anything under it. The page previously read as
    // though naming an instance covered everything beneath it, which is a
    // stronger promise than the server keeps. Keeping exact matching is a
    // deliberate policy — the same one Mastodon applies — so the page has to say
    // so rather than the engine being quietly widened to match the page.
    expect(texts).toContain(scope);

    // Asserted on the substance, not the sentence: a reword may change every
    // word here, but copy that stops naming what is NOT covered has stopped
    // doing the job this paragraph exists for.
    expect(scope?.toLowerCase()).toContain('subdomain');
    expect(scope?.toLowerCase()).toContain('exactly');
  });
});
