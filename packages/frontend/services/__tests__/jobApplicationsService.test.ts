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

import { jobApplicationsService } from '@/services/jobApplicationsService';

describe('jobApplicationsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('submits an application to the nested job path', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { application: { id: 'app-1' } } });

    await jobApplicationsService.submit('job-1', { displayName: 'Jordan' });

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/applications', { displayName: 'Jordan' });
  });

  it('lists applications for the employer, forwarding filters as params', async () => {
    mockAuthenticated.get.mockResolvedValue({ data: { applications: [], hasMore: false } });

    await jobApplicationsService.listForEmployer('job-1', { status: 'new', limit: 20 });

    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/job-1/applications', {
      params: { status: 'new', limit: 20 },
    });
  });

  it('updates an application status on its own path', async () => {
    mockAuthenticated.put.mockResolvedValue({ data: { application: { id: 'app-1', status: 'reviewing' } } });

    await jobApplicationsService.updateStatus('job-1', 'app-1', 'reviewing');

    expect(mockAuthenticated.put).toHaveBeenCalledWith('/jobs/job-1/applications/app-1', { status: 'reviewing' });
  });

  it('adds and lists internal notes on the notes sub-path', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { note: { id: 'note-1' } } });
    mockAuthenticated.get.mockResolvedValue({ data: { notes: [] } });

    await jobApplicationsService.addNote('job-1', 'app-1', 'Strong candidate');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/applications/app-1/notes', {
      note: 'Strong candidate',
    });

    await jobApplicationsService.listNotes('job-1', 'app-1');
    expect(mockAuthenticated.get).toHaveBeenCalledWith('/jobs/job-1/applications/app-1/notes');
  });

  it('withdraws the caller’s own application', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { application: { id: 'app-1', status: 'withdrawn' } } });

    await jobApplicationsService.withdraw('job-1', 'app-1');

    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/job-1/applications/app-1/withdraw');
  });

  it('reports an external Clarity-only job through the proxy endpoint, with an optional detail', async () => {
    mockAuthenticated.post.mockResolvedValue({ data: { status: 'received' } });

    await jobApplicationsService.reportExternalJob('clarity-job-1', 'scam');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/external/clarity-job-1/report', {
      reason: 'scam',
      detail: undefined,
    });

    await jobApplicationsService.reportExternalJob('clarity-job-1', 'duplicate', 'Same posting as job-2');
    expect(mockAuthenticated.post).toHaveBeenCalledWith('/jobs/external/clarity-job-1/report', {
      reason: 'duplicate',
      detail: 'Same posting as job-2',
    });
  });
});
