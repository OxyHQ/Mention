import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertSafePublicUrl: vi.fn(),
  getLinkPreview: vi.fn(),
}));

vi.mock('../../utils/ssrfGuard', () => ({
  assertSafePublicUrl: mocks.assertSafePublicUrl,
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getLinkPreview: mocks.getLinkPreview,
  }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn() },
}));

import { warmLinkPreviewForText } from '../../utils/linkPreviewWarm';

describe('warmLinkPreviewForText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
    mocks.getLinkPreview.mockResolvedValue({});
  });

  it('validates extracted URLs before warming through Oxy', async () => {
    await warmLinkPreviewForText('Read https://example.com/post');

    expect(mocks.assertSafePublicUrl).toHaveBeenCalledWith('https://example.com/post');
    expect(mocks.getLinkPreview).toHaveBeenCalledWith('https://example.com/post', { wait: true });
  });

  it('does not warm URLs rejected by the SSRF guard', async () => {
    mocks.assertSafePublicUrl.mockResolvedValue({ ok: false, reason: 'literal ip in blocked range' });

    await warmLinkPreviewForText('metadata http://169.254.169.254/latest/meta-data/');

    expect(mocks.assertSafePublicUrl).toHaveBeenCalledWith('http://169.254.169.254/latest/meta-data/');
    expect(mocks.getLinkPreview).not.toHaveBeenCalled();
  });
});
