import { toast } from '@oxy.so/bloom/toast';
import { shareUrl } from '@oxy.so/bloom/hooks';
import { shareLink } from '../shareLink';

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/bloom/hooks', () => ({ shareUrl: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

const OPTIONS = {
  title: 'A post',
  url: 'https://mention.earth/p/1',
  copiedToast: 'Copied',
  errorToast: 'Could not share',
};
const share = shareUrl as jest.Mock;

describe('shareLink', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hands the message (title by default) and a clipboard fallback to Bloom', async () => {
    share.mockResolvedValue('shared');
    await shareLink({ ...OPTIONS, message: 'Look at this' });
    expect(share).toHaveBeenCalledWith({
      title: 'A post',
      url: 'https://mention.earth/p/1',
      message: 'Look at this',
      copyText: 'Look at this\n\nhttps://mention.earth/p/1',
    });
    await shareLink(OPTIONS);
    expect(share.mock.calls[1][0].message).toBe('A post');
    expect(toast).not.toHaveBeenCalled();
  });

  it('stays silent when the viewer dismisses the sheet', async () => {
    share.mockResolvedValue('dismissed');
    await shareLink(OPTIONS);
    expect(toast).not.toHaveBeenCalled();
  });

  it('confirms a copy and reports a failure', async () => {
    share.mockResolvedValue('copied');
    await shareLink(OPTIONS);
    expect(toast).toHaveBeenCalledWith('Copied', { type: 'success' });
    share.mockResolvedValue('failed');
    await shareLink(OPTIONS);
    expect(toast).toHaveBeenCalledWith('Could not share', { type: 'error' });
  });
});
