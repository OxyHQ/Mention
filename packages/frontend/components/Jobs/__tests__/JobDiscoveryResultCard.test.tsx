import React from 'react';
import TestRenderer, { type ReactTestInstance, type ReactTestRenderer, act } from 'react-test-renderer';
import type { JobSearchResult } from '@clarity.surf/sdk';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));

jest.mock('@oxy.so/bloom/icons', () => ({
  RiBookmarkFill: () => null,
  RiBookmarkLine: () => null,
  RiCheckboxCircleFill: () => null,
  RiFlagLine: () => null,
  RiGlobalLine: () => null,
  RiLoader4Line: () => null,
  RiShareForwardLine: () => null,
}));

jest.mock('@oxy.so/bloom/badge', () => ({
  Badge: ({ content }: { content: string }) => content,
}));
jest.mock('@oxy.so/bloom/item', () => ({
  Item: ({ title }: { title: string }) => title,
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { primary: '#000', textSecondary: '#666', textTertiary: '#999' } }),
}));

const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; domain?: string }) => {
      const value = options?.defaultValue ?? _key;
      return options?.domain ? value.replace('{{domain}}', options.domain) : value;
    },
  }),
}));

const mockOpenExternalLink = jest.fn();
jest.mock('@/utils/openExternalLink', () => ({ openExternalLink: (...args: unknown[]) => mockOpenExternalLink(...args) }));

const mockShareLink = jest.fn();
jest.mock('@/utils/shareLink', () => ({ shareLink: (...args: unknown[]) => mockShareLink(...args) }));

jest.mock('@/config', () => ({ WEB_BASE_URL: 'https://mention.earth' }));

const mockReportExternalJob = jest.fn();
jest.mock('@/services/jobApplicationsService', () => ({
  jobApplicationsService: { reportExternalJob: (...args: unknown[]) => mockReportExternalJob(...args) },
}));

import JobDiscoveryResultCard, { ExternalJobReportSheet } from '../JobDiscoveryResultCard';

function result(overrides: Partial<JobSearchResult> = {}): JobSearchResult {
  return {
    id: 'result-1',
    documentId: 'doc-1',
    canonicalUrl: 'https://boards.example.com/jobs/widget-engineer',
    title: 'Widget Engineer',
    employer: { name: 'Acme Corp' },
    locations: [{ raw: 'Remote' }],
    applicantLocationRequirements: [],
    employmentTypes: ['full_time'],
    skills: [],
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    status: 'active',
    source: {
      type: 'web',
      domain: 'boards.example.com',
      canonicalUrl: 'https://boards.example.com/jobs/widget-engineer',
      documentId: 'doc-1',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      status: 'active',
    },
    otherSources: [],
    evidence: {},
    score: 1,
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

function pressHandlers(renderer: ReactTestRenderer): Array<() => void> {
  return renderer.root
    .findAll((node: ReactTestInstance) => typeof node.props?.onPress === 'function', { deep: true })
    .map((node) => node.props.onPress as () => void);
}

/** Finds the (outermost) onPress handler for the node carrying this accessibilityLabel. */
function pressHandlerByLabel(renderer: ReactTestRenderer, label: string): () => void {
  const matches = renderer.root.findAll(
    (node: ReactTestInstance) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
    { deep: true },
  );
  return matches[0].props.onPress as () => void;
}

beforeEach(() => {
  mockPush.mockReset();
  mockOpenExternalLink.mockReset();
  mockShareLink.mockReset();
  mockToast.mockReset();
  mockReportExternalJob.mockReset();
});

describe('JobDiscoveryResultCard', () => {
  it('appends a posted-time label when publishedAt is set, and omits it otherwise', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const posted = render(<JobDiscoveryResultCard job={result({ publishedAt: twoHoursAgo })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />);
    expect(textOf(posted)).toContain('· 2h');

    const unposted = render(<JobDiscoveryResultCard job={result({ publishedAt: undefined })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />);
    expect(textOf(unposted)).not.toContain('2h');
  });

  it('treats a salary object with neither a floor nor a ceiling as no salary at all', () => {
    const renderer = render(
      <JobDiscoveryResultCard job={result({ salary: { currency: 'USD', interval: 'year' } })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />,
    );
    expect(textOf(renderer)).not.toContain('USD');
  });

  it('falls all the way back to job.canonicalUrl when the source has neither an applyUrl nor a canonicalUrl of its own', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({
          canonicalUrl: 'https://boards.example.com/jobs/fallback-path',
          source: {
            type: 'web',
            domain: 'boards.example.com',
            canonicalUrl: '',
            documentId: 'doc-1',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            status: 'active',
          },
        })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    act(() => {
      pressHandlers(renderer)[0]();
    });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://boards.example.com/jobs/fallback-path');
  });

  it('opens the top-level applyUrl when the source has none of its own', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({ applyUrl: 'https://boards.example.com/apply-direct' })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    act(() => {
      pressHandlers(renderer)[0]();
    });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://boards.example.com/apply-direct');
  });

  it('shows the already-saved icon state and label when isSaved is true', () => {
    const renderer = render(<JobDiscoveryResultCard job={result()} isSaved onToggleSave={jest.fn()} onReport={jest.fn()} />);
    expect(() => pressHandlerByLabel(renderer, 'Remove from saved')).not.toThrow();
  });

  it('renders title, employer, location and salary for an external listing, attributed via its own domain', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({ salary: { min: 80000, max: 100000, currency: 'USD', interval: 'year' } })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    const text = textOf(renderer);
    expect(text).toContain('Widget Engineer');
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Remote');
    expect(text).toContain('USD 80,000–100,000 / year');
    expect(text).toContain('boards.example.com');
    expect(text).not.toContain('On Mention');
  });

  it('formats a salary with only a floor, only a ceiling, and neither', () => {
    expect(
      textOf(render(<JobDiscoveryResultCard job={result({ salary: { min: 50000, currency: 'USD', interval: 'year' } })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />)),
    ).toContain('50,000+');
    expect(
      textOf(render(<JobDiscoveryResultCard job={result({ salary: { max: 90000, currency: 'USD', interval: 'year' } })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />)),
    ).toContain('Up to 90,000');
    expect(
      textOf(render(<JobDiscoveryResultCard job={result({ salary: undefined })} isSaved={false} onToggleSave={jest.fn()} onReport={jest.fn()} />)),
    ).not.toMatch(/\d,\d{3}/);
  });

  it('routes to an in-app path for a first-party result on this app\'s own web origin, and hides the report button', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({
          source: {
            type: 'first_party',
            domain: 'mention.earth',
            canonicalUrl: 'https://mention.earth/jobs/widget-engineer-ab12',
            documentId: 'doc-1',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            status: 'active',
          },
        })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain('On Mention');

    act(() => {
      pressHandlers(renderer)[0]();
    });
    expect(mockPush).toHaveBeenCalledWith('/jobs/widget-engineer-ab12');
    expect(mockOpenExternalLink).not.toHaveBeenCalled();
  });

  it('treats a first-party result whose canonical URL is on a DIFFERENT host as external (opens externally, keeps the report button)', () => {
    const onReport = jest.fn();
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({
          source: {
            type: 'first_party',
            domain: 'boards.example.com',
            canonicalUrl: 'https://boards.example.com/jobs/widget-engineer',
            documentId: 'doc-1',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            status: 'active',
          },
        })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={onReport}
      />,
    );
    expect(textOf(renderer)).not.toContain('On Mention');

    act(() => {
      pressHandlers(renderer)[0]();
    });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://boards.example.com/jobs/widget-engineer');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens the source applyUrl over the canonical URL when both are present', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({
          source: {
            type: 'web',
            domain: 'boards.example.com',
            canonicalUrl: 'https://boards.example.com/jobs/widget-engineer',
            applyUrl: 'https://boards.example.com/jobs/widget-engineer/apply',
            documentId: 'doc-1',
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            status: 'active',
          },
        })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );

    act(() => {
      pressHandlers(renderer)[0]();
    });
    expect(mockOpenExternalLink).toHaveBeenCalledWith('https://boards.example.com/jobs/widget-engineer/apply');
  });

  it('calls onToggleSave and onReport with the job, and shares the canonical URL', () => {
    const onToggleSave = jest.fn();
    const onReport = jest.fn();
    const job = result();
    const renderer = render(
      <JobDiscoveryResultCard job={job} isSaved={false} onToggleSave={onToggleSave} onReport={onReport} />,
    );
    act(() => pressHandlerByLabel(renderer, 'Save job')());
    expect(onToggleSave).toHaveBeenCalledWith(job);

    act(() => pressHandlerByLabel(renderer, 'Share')());
    expect(mockShareLink).toHaveBeenCalledWith(expect.objectContaining({ title: 'Widget Engineer', url: job.canonicalUrl }));

    act(() => pressHandlerByLabel(renderer, 'Report')());
    expect(onReport).toHaveBeenCalledWith(job);
  });

  it('renders nothing extra for a listing with no badges, salary or snippet', () => {
    const renderer = render(
      <JobDiscoveryResultCard
        job={result({ locations: [], workplaceType: undefined, employmentTypes: [], salary: undefined, snippet: undefined })}
        isSaved={false}
        onToggleSave={jest.fn()}
        onReport={jest.fn()}
      />,
    );
    expect(textOf(renderer)).not.toContain('undefined');
  });
});

describe('ExternalJobReportSheet', () => {
  it('submits the selected reason, toasts success, and closes', async () => {
    mockReportExternalJob.mockResolvedValue(undefined);
    const onClose = jest.fn();
    const renderer = render(<ExternalJobReportSheet clarityJobId="doc-1" onClose={onClose} />);

    await act(async () => {
      pressHandlers(renderer)[0]();
      await Promise.resolve();
    });

    expect(mockReportExternalJob).toHaveBeenCalledWith('doc-1', 'scam');
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('reported'), { type: 'success' });
    expect(onClose).toHaveBeenCalled();
  });

  it('toasts an error and still closes when the report submission fails', async () => {
    mockReportExternalJob.mockRejectedValue(new Error('network down'));
    const onClose = jest.fn();
    const renderer = render(<ExternalJobReportSheet clarityJobId="doc-1" onClose={onClose} />);

    await act(async () => {
      pressHandlers(renderer)[0]();
      await Promise.resolve();
    });

    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Could not'), { type: 'error' });
    expect(onClose).toHaveBeenCalled();
  });
});
