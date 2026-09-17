import { Share } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { shareLink } from '../shareLink';

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const OPTIONS = {
  title: 'A post',
  url: 'https://mention.earth/p/1',
  copiedToast: 'Copied',
  errorToast: 'Could not share',
};

describe('shareLink (native)', () => {
  let share: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    share = jest.spyOn(Share, 'share');
  });

  afterEach(() => {
    share.mockRestore();
  });

  it('opens the share sheet with the message, then the link', async () => {
    share.mockResolvedValue({ action: Share.sharedAction });
    await shareLink({ ...OPTIONS, message: 'Look at this' });
    expect(share).toHaveBeenCalledWith({
      message: 'Look at this\n\nhttps://mention.earth/p/1',
      url: 'https://mention.earth/p/1',
      title: 'A post',
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it('falls back to the title when there is no message', async () => {
    share.mockResolvedValue({ action: Share.sharedAction });
    await shareLink(OPTIONS);
    expect(share.mock.calls[0][0].message).toBe('A post\n\nhttps://mention.earth/p/1');
  });

  it('stays silent when the viewer dismisses the sheet', async () => {
    share.mockRejectedValue(new Error('User did not share (cancelled)'));
    await shareLink(OPTIONS);
    expect(toast).not.toHaveBeenCalled();
  });

  it('tells the viewer when sharing genuinely fails', async () => {
    share.mockRejectedValue(new Error('No activity found'));
    await shareLink(OPTIONS);
    expect(toast).toHaveBeenCalledWith('Could not share', { type: 'error' });
  });
});
