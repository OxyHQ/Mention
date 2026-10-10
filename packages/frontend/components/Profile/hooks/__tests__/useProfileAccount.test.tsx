import TestRenderer, { act } from 'react-test-renderer';
import { useProfileAccount, type ProfileAccount } from '../useProfileAccount';

const mockUseProfileData = jest.fn();

jest.mock('@/hooks/useProfileData', () => ({
  useProfileData: (handle: string) => mockUseProfileData(handle),
}));
jest.mock('@/hooks/useProfileScreenColor', () => ({
  useProfileScreenColor: () => ({ colorName: undefined }),
}));
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: ({
    username,
    instance,
    isFederated,
  }: {
    username?: string;
    instance?: string;
    isFederated?: boolean;
  }) => (isFederated && instance ? `${username}@${instance}` : username),
}));
jest.mock('../../profileRoute', () => ({ canonicalProfileHref: () => null }));

let latest: ProfileAccount | null = null;
function Probe({ handle }: { handle: string }) {
  latest = useProfileAccount(handle);
  return null;
}

function account(handle: string): ProfileAccount {
  act(() => {
    TestRenderer.create(<Probe handle={handle} />);
  });
  if (!latest) throw new Error('probe never rendered');
  return latest;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  latest = null;
  mockUseProfileData.mockReset();
});

/** The account every profile screen looks up — and, since #1124, whether it exists. */
describe('useProfileAccount', () => {
  it('passes on that the account does not exist', () => {
    mockUseProfileData.mockReturnValue({
      data: null,
      loading: false,
      notFound: true,
      refresh: jest.fn(),
    });
    const result = account('@qa_missing');
    expect(mockUseProfileData).toHaveBeenCalledWith('qa_missing');
    expect(result).toMatchObject({
      username: 'qa_missing',
      handle: 'qa_missing',
      profileData: null,
      notFound: true,
    });
  });

  it('passes on a failed lookup as a failure, not as "not found"', () => {
    mockUseProfileData.mockReturnValue({
      data: null,
      loading: false,
      notFound: false,
      refresh: jest.fn(),
    });
    expect(account('someone').notFound).toBe(false);
  });

  it('names a federated account by its full handle', () => {
    mockUseProfileData.mockReturnValue({
      data: { username: 'alice', instance: 'mastodon.social', isFederated: true, design: {} },
      loading: false,
      notFound: false,
      refresh: jest.fn(),
    });
    const result = account('alice@mastodon.social');
    expect(result.isFederated).toBe(true);
    expect(result.handle).toBe('alice@mastodon.social');
  });
});
