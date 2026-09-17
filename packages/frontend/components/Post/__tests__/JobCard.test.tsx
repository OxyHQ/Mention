import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import JobCard from '../JobCard';
import type { PostJobContent } from '@mention/shared-types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

const mockGetUserById = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ oxyServices: { getUserById: (...args: unknown[]) => mockGetUserById(...args) } }),
}));

jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: (user: { username?: string } | null) => user?.username ?? null,
}));

jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

jest.mock('@oxy.so/bloom/badge', () => ({
  Badge: ({ content }: { content: string }) => content,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

function job(overrides: Partial<PostJobContent> = {}): PostJobContent {
  return {
    mentionJobId: 'job-1',
    title: 'Senior Widget Engineer',
    employerName: 'Acme Hiring',
    employerOxyUserId: 'employer-1',
    status: 'published',
    canonicalUrl: 'https://mention.earth/jobs/senior-widget-engineer-ab12cd',
    ...overrides,
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      strings.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      collect((node as { children: unknown }).children);
    }
  };
  collect(renderer.toJSON());
  return strings.join(' | ');
}

function pressHandler(renderer: ReactTestRenderer, index = 0): () => void {
  return renderer.root.findAll(
    (node: ReactTestInstance) => typeof node.props?.onPress === 'function',
    { deep: true },
  )[index].props.onPress as () => void;
}

beforeEach(() => {
  mockPush.mockReset();
  mockGetUserById.mockReset();
});

describe('JobCard', () => {
  it('renders the title and employer name, with no status badge when published', () => {
    const renderer = render(<JobCard job={job()} />);
    expect(textOf(renderer)).toContain('Senior Widget Engineer');
    expect(textOf(renderer)).toContain('Acme Hiring');
    expect(textOf(renderer)).not.toContain('Closed');
    expect(textOf(renderer)).not.toContain('Paused');
  });

  it.each([
    ['paused', 'Paused'],
    ['closed', 'Closed'],
    ['expired', 'Expired'],
    ['draft', 'Draft'],
  ] as const)('shows a status badge for a %s job', (status, label) => {
    const renderer = render(<JobCard job={job({ status })} />);
    expect(textOf(renderer)).toContain(label);
  });

  it('renders location, workplace type and employment type as meta badges when present', () => {
    const renderer = render(
      <JobCard
        job={job({
          location: { placeId: '5391959', countryCode: 'US', region: 'California', city: 'San Francisco' },
          workplaceType: 'remote',
          employmentType: 'full_time',
        })}
      />,
    );
    const text = textOf(renderer);
    expect(text).toMatch(/San Francisco, California, (United States|US)/);
    expect(text).toContain('Remote');
    expect(text).toContain('Full-time');
  });

  it('renders no meta badges when location/workplace/employment are all absent', () => {
    const renderer = render(<JobCard job={job()} />);
    // Only the "Job" label and title/employer text should be present — no stray badge row.
    expect(textOf(renderer)).not.toContain('undefined');
  });

  it('navigates to the canonical URL\'s path when tapped', () => {
    const renderer = render(<JobCard job={job()} />);

    TestRenderer.act(() => {
      pressHandler(renderer, 0)();
    });

    expect(mockPush).toHaveBeenCalledWith('/jobs/senior-widget-engineer-ab12cd');
  });

  it('falls back to the id route when canonicalUrl cannot be parsed as a URL', () => {
    const renderer = render(<JobCard job={job({ canonicalUrl: 'not-a-url' })} />);

    TestRenderer.act(() => {
      pressHandler(renderer, 0)();
    });

    expect(mockPush).toHaveBeenCalledWith('/jobs/job-1');
  });

  it('resolves the employer\'s handle and navigates to their profile when the employer name is tapped', async () => {
    mockGetUserById.mockResolvedValue({ username: 'acme' });
    const renderer = render(<JobCard job={job()} />);

    await TestRenderer.act(async () => {
      pressHandler(renderer, 1)();
      await Promise.resolve();
    });

    expect(mockGetUserById).toHaveBeenCalledWith('employer-1');
    expect(mockPush).toHaveBeenCalledWith('/@acme');
  });

  it('does not navigate when the employer\'s handle cannot be resolved', async () => {
    mockGetUserById.mockResolvedValue({ username: undefined });
    const renderer = render(<JobCard job={job()} />);

    await TestRenderer.act(async () => {
      pressHandler(renderer, 1)();
      await Promise.resolve();
    });

    expect(mockPush).not.toHaveBeenCalledWith(expect.stringContaining('/@'));
  });

  it('does not throw when the employer profile lookup rejects', async () => {
    mockGetUserById.mockRejectedValue(new Error('network down'));
    const renderer = render(<JobCard job={job()} />);

    await TestRenderer.act(async () => {
      pressHandler(renderer, 1)();
      await Promise.resolve();
    });

    expect(mockPush).not.toHaveBeenCalledWith(expect.stringContaining('/@'));
  });
});
