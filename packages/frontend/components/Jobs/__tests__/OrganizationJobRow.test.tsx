import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer, act } from 'react-test-renderer';
import type { MentionJobPosting } from '@mention/shared-types';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

jest.mock('@oxy.so/bloom/badge', () => ({
  Badge: ({ content }: { content: string }) => content,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; time?: string }) =>
      (options?.defaultValue ?? _key).replace('{{time}}', options?.time ?? ''),
  }),
}));

import OrganizationJobRow from '../OrganizationJobRow';

function job(overrides: Partial<MentionJobPosting> = {}): MentionJobPosting {
  return {
    id: 'job-1',
    employerOxyUserId: 'employer-1',
    authorOxyUserId: 'employer-1',
    title: 'Widget Engineer',
    description: 'Build widgets',
    skills: [],
    applicationMode: 'external',
    externalApplyUrl: 'https://example.com',
    status: 'published',
    slug: 'widget-engineer-ab12',
    canonicalUrl: 'https://mention.earth/jobs/widget-engineer-ab12',
    applicationCount: 0,
    claritySyncStatus: 'synced',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
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

function press(renderer: ReactTestRenderer): void {
  const handler = renderer.root.find(
    (node: ReactTestInstance) => typeof node.props?.onPress === 'function',
  ).props.onPress as () => void;
  act(() => handler());
}

beforeEach(() => {
  mockPush.mockReset();
});

describe('OrganizationJobRow', () => {
  it('renders the title with no status badge when published', () => {
    const renderer = render(<OrganizationJobRow job={job()} />);
    expect(textOf(renderer)).toContain('Widget Engineer');
    expect(textOf(renderer)).not.toContain('paused');
  });

  it('shows the raw status as a badge for anything not published', () => {
    const renderer = render(<OrganizationJobRow job={job({ status: 'paused' })} />);
    expect(textOf(renderer)).toContain('paused');
  });

  it('renders location, workplace type and employment type badges when present', () => {
    const renderer = render(
      <OrganizationJobRow
        job={job({ location: { raw: 'Berlin, DE' }, workplaceType: 'hybrid', employmentType: 'contract' })}
      />,
    );
    const text = textOf(renderer);
    expect(text).toContain('Berlin, DE');
    expect(text).toContain('Hybrid');
    expect(text).toContain('Contract');
  });

  it('formats a full salary range, a floor-only salary, and no salary at all', () => {
    expect(
      textOf(render(<OrganizationJobRow job={job({ salary: { min: 60000, max: 80000, currency: 'EUR', interval: 'year' } })} />)),
    ).toContain('EUR 60,000–80,000 / year');
    expect(
      textOf(render(<OrganizationJobRow job={job({ salary: { min: 60000, currency: 'EUR', interval: 'year' } })} />)),
    ).toContain('60,000+');
    expect(textOf(render(<OrganizationJobRow job={job({ salary: undefined })} />))).not.toMatch(/\d,\d{3}/);
  });

  it('shows "Published …" when publishedAt is set, and "Created …" otherwise', () => {
    expect(textOf(render(<OrganizationJobRow job={job({ publishedAt: new Date().toISOString() })} />))).toContain(
      'Published',
    );
    expect(textOf(render(<OrganizationJobRow job={job({ publishedAt: undefined })} />))).toContain('Created');
  });

  it('navigates to the canonical URL\'s path when tapped, falling back to the id route otherwise', () => {
    const renderer = render(<OrganizationJobRow job={job()} />);
    press(renderer);
    expect(mockPush).toHaveBeenCalledWith('/jobs/widget-engineer-ab12');

    mockPush.mockReset();
    const fallbackRenderer = render(<OrganizationJobRow job={job({ canonicalUrl: 'not-a-url' })} />);
    press(fallbackRenderer);
    expect(mockPush).toHaveBeenCalledWith('/jobs/job-1');
  });
});
