// `mock`-prefixed on purpose: jest hoists `jest.mock` above these declarations
// and rejects a factory that closes over anything else.
const mockAuthenticated = {
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
};

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockAuthenticated.get(...args),
    post: (...args: unknown[]) => mockAuthenticated.post(...args),
    put: (...args: unknown[]) => mockAuthenticated.put(...args),
  },
}));

import {
  jobsService,
  recordJobMetric,
  isJobEntitlementError,
  isJobForbiddenError,
  isJobServiceUnavailableError,
  getJobErrorMessage,
} from '@/services/jobsService';

function axiosError(status: number, body?: Record<string, unknown>) {
  const error = new Error('request failed') as Error & {
    isAxiosError: true;
    response: { status: number; data?: Record<string, unknown> };
  };
  error.isAxiosError = true;
  error.response = { status, data: body };
  return error;
}

describe('jobsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hits every read endpoint on the correct path, forwarding filters as params', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: { jobs: [] } });

    await jobsService.list({ q: 'engineer' });
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs', { params: { q: 'engineer' } });

    await jobsService.getMine({ status: 'published' });
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/mine', { params: { status: 'published' } });

    await jobsService.getOrganizationJobs('employer-1', { limit: 10 });
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/organization/employer-1', { params: { limit: 10 } });

    await jobsService.get('job-1');
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/job-1');

    await jobsService.getMetrics('job-1');
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/job-1/metrics');
  });

  it('hits every write endpoint on the correct path, with the right body', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { job: { id: 'job-1' } } });
    mockAuthenticated.put.mockResolvedValue({ data: { job: { id: 'job-1' } } });

    await jobsService.create({
      employerOxyUserId: 'employer-1',
      title: 'Widget Engineer',
      description: 'Build widgets',
      applicationMode: 'external',
      externalApplyUrl: 'https://example.com',
    });
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs', expect.objectContaining({ title: 'Widget Engineer' }));

    await jobsService.update('job-1', { title: 'Senior Widget Engineer' });
    expect(mockAuthenticated.put).toHaveBeenCalledWith('/jobs/job-1', { title: 'Senior Widget Engineer' });

    await jobsService.publish('job-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/publish');

    await jobsService.pause('job-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/pause');

    await jobsService.close('job-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/close');

    await jobsService.duplicate('job-1');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/duplicate');
  });

  it('records a metric event with the given kind', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: {} });

    await jobsService.recordMetric('job-1', 'view');

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/metrics', { event: 'view' });
  });

  it('recordJobMetric never throws even when the request rejects', async () => {
    mockAuthenticated.post.mockRejectedValue(new Error('network down'));

    expect(() => recordJobMetric('job-1', 'view')).not.toThrow();
    // Let the fire-and-forget promise settle before the test ends.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('classifies entitlement (402), forbidden (403) and service-unavailable (503) errors, and nothing else', () => {
    expect(isJobEntitlementError(axiosError(402))).toBe(true);
    expect(isJobEntitlementError(axiosError(403))).toBe(false);

    expect(isJobForbiddenError(axiosError(403))).toBe(true);
    expect(isJobForbiddenError(axiosError(402))).toBe(false);

    expect(isJobServiceUnavailableError(axiosError(503))).toBe(true);
    expect(isJobServiceUnavailableError(axiosError(200))).toBe(false);

    expect(isJobEntitlementError(new Error('not an axios error'))).toBe(false);
  });

  it('prefers the backend’s own error message, falling back when absent', () => {
    expect(getJobErrorMessage(axiosError(400, { error: 'title is required' }), 'fallback')).toBe(
      'title is required',
    );
    expect(getJobErrorMessage(new Error('plain error'), 'fallback')).toBe('fallback');
  });
});
