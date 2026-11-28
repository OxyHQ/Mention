/**
 * @jest-environment jsdom
 */
import { readPersistedViewerOwner } from '@/db';
import { startBootFeedRead } from '@/services/feedPageRead';
import { startHomeFeedBootRead } from '@/lib/bootFeedRead.web';

let mockToken: string | null = null;
let mockTokenListener: ((token: string | null) => void) | undefined;

jest.mock('@/db', () => ({ readPersistedViewerOwner: jest.fn() }));
let mockLanguageReady: Promise<void>;
jest.mock('@/lib/i18n', () => ({ waitForLanguageReady: () => mockLanguageReady }));
jest.mock('@/services/feedPageRead', () => ({ startBootFeedRead: jest.fn() }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: {
    http: {
      getAccessToken: () => mockToken,
      addTokenChangeListener: (listener: (token: string | null) => void) => {
        mockTokenListener = listener;
        return () => {
          mockTokenListener = undefined;
        };
      },
    },
    session: {
      get userId() {
        return mockToken ? `user-of-${mockToken}` : null;
      },
    },
  },
}));

const owner = readPersistedViewerOwner as jest.Mock;
const start = startBootFeedRead as jest.Mock;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the home feed boot read', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLanguageReady = Promise.resolve();
    mockToken = null;
    mockTokenListener = undefined;
  });

  it('reads anonymously for a signed-out last viewer, only on the home page', async () => {
    owner.mockReturnValue('anon');
    window.history.pushState({}, '', '/explore');
    startHomeFeedBootRead();
    window.history.pushState({}, '', '/');
    startHomeFeedBootRead();
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(null);
  });

  it("reads as the bearer's account once the session lands for a signed-in last viewer", async () => {
    owner.mockReturnValue('viewer-a');
    startHomeFeedBootRead();
    await settle();
    expect(start).not.toHaveBeenCalled();

    mockToken = 'token-a';
    mockTokenListener?.('token-a');
    await settle();

    expect(start).toHaveBeenCalledWith('user-of-token-a');
    expect(mockTokenListener).toBeUndefined();
  });

  it('starts immediately when the session already exists', async () => {
    owner.mockReturnValue('viewer-a');
    window.history.pushState({}, '', '/');
    mockToken = 'token-a';

    startHomeFeedBootRead();
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('user-of-token-a');
    expect(mockTokenListener).toBeUndefined();
  });

  it('does not use an already available token after the session changes while language loads', async () => {
    owner.mockReturnValue('viewer-a');
    window.history.pushState({}, '', '/');
    mockToken = 'token-a';
    let ready: () => void = () => {
      throw new Error('Language readiness was not initialized');
    };
    mockLanguageReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    startHomeFeedBootRead();
    mockToken = 'token-b';
    ready();
    await settle();

    expect(start).not.toHaveBeenCalled();
  });
  it('waits for the SDK-selected catalog without choosing its own boot language', async () => {
    owner.mockReturnValue('anon');
    window.history.pushState({}, '', '/');
    let ready!: () => void;
    mockLanguageReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    startHomeFeedBootRead();
    await settle();
    expect(start).not.toHaveBeenCalled();
    ready();
    await settle();
    expect(start).toHaveBeenCalledWith(null);
  });
});
