/**
 * `channelAccountService` — the channel byline toggle's client half.
 *
 * The read and the write do NOT share a path, and that asymmetry is deliberate
 * rather than an oversight, so it is pinned here.
 *
 * `GET /profile/settings/:id` answers a VIEWER's question — it serves the profile
 * design DTO, and returns the stored settings document only when the target IS the
 * viewer. A channel can never be its own viewer (no session can be minted whose
 * subject is a channel), so that response never carries a `channel` block and
 * reading `signPosts` off it yielded `undefined` however the operator had it set.
 * The read therefore goes to the operator-gated `/channel` sub-route.
 *
 * Without this test the frontend half of that fix is unpinned: pointing the read
 * back at the bare settings path would restore the bug with every backend test
 * still green.
 *
 * The write also has to REPORT itself, and that is the second thing pinned here.
 * Flipping the toggle rewrites the byline of every post the channel has published,
 * and the caches holding those posts have no way to learn it: a byline is not a
 * field a client can correct (with disclosure off the writer's id is never sent
 * here at all), so the only answer is to ask the server again. This is the join
 * between the two halves of that fix and the one place a regression would be
 * completely silent — `useFeedState` keeps honouring the signal perfectly, the
 * service simply stops sending it, and every surface goes back to needing a
 * reload.
 */

import { authenticatedClient } from '@/utils/api';

import { channelAccountService } from '../channelAccountService';

// The factory closes over nothing, so `jest.mock`'s hoisting above these imports
// cannot land the mocks in the temporal dead zone — which is what lets the
// imports stay first and keeps `import/first` satisfied.
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: jest.fn(), put: jest.fn() },
}));

const mockNoteBylineChanged = jest.fn();

jest.mock('@/stores/bylineInvalidation', () => ({
  noteChannelBylineChanged: (...args: unknown[]) => mockNoteBylineChanged(...args),
}));

const mockGet = jest.mocked(authenticatedClient.get);
const mockPut = jest.mocked(authenticatedClient.put);

const CHANNEL = 'channel-account-1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('channelAccountService.getSettings', () => {
  it('reads from the operator-gated /channel sub-route, not the viewer settings path', async () => {
    mockGet.mockResolvedValue({ data: { channel: { signPosts: true } } });

    await channelAccountService.getSettings(CHANNEL);

    expect(mockGet).toHaveBeenCalledWith(`/profile/settings/${CHANNEL}/channel`);
  });

  /**
   * The fixture has to be ON. `false` is the default, so a stored-`false` case
   * cannot tell "reads the value" from "always answers false" — which is exactly
   * the behaviour this fixed.
   */
  it('reads back a signPosts that is ON', async () => {
    mockGet.mockResolvedValue({ data: { channel: { signPosts: true } } });

    await expect(channelAccountService.getSettings(CHANNEL)).resolves.toEqual({ signPosts: true });
  });

  it('reads back a signPosts that is off', async () => {
    mockGet.mockResolvedValue({ data: { channel: { signPosts: false } } });

    await expect(channelAccountService.getSettings(CHANNEL)).resolves.toEqual({ signPosts: false });
  });

  /**
   * A response with no `channel` block at all — what the OLD path returned, and
   * what a future regression would return again. It must read as off rather than
   * as `undefined` reaching the switch.
   */
  it('treats a response with no channel block as off', async () => {
    mockGet.mockResolvedValue({ data: {} });

    await expect(channelAccountService.getSettings(CHANNEL)).resolves.toEqual({ signPosts: false });
  });

  /**
   * Tells `=== true` from `Boolean(...)`: only a truthy NON-boolean makes the two
   * readings disagree, and the loose one would name the human who wrote the post.
   */
  it.each([['the string "false"', 'false'], ['the number 1', 1], ['an object', {}]])(
    'refuses to read %s as consent to name the writer',
    async (_label, value) => {
      mockGet.mockResolvedValue({ data: { channel: { signPosts: value } } });

      await expect(channelAccountService.getSettings(CHANNEL)).resolves.toEqual({ signPosts: false });
    },
  );
});

describe('channelAccountService.setSignPosts', () => {
  it('writes to the settings path the operated-account route serves', async () => {
    mockPut.mockResolvedValue({ data: { channel: { signPosts: true } } });

    await channelAccountService.setSignPosts(CHANNEL, true);

    expect(mockPut).toHaveBeenCalledWith(`/profile/settings/${CHANNEL}`, {
      channel: { signPosts: true },
    });
  });

  it('falls back to the requested value when the server answers tersely', async () => {
    mockPut.mockResolvedValue({ data: {} });

    await expect(channelAccountService.setSignPosts(CHANNEL, true)).resolves.toEqual({
      signPosts: true,
    });
  });

  /**
   * BOTH directions, because they are not the same fix. Turning the byline OFF
   * could in principle be served by stripping the writer out of the cached posts;
   * turning it ON cannot, because the writer's id was never sent while the channel
   * kept them anonymous. A report that fired on only one of them would leave the
   * other needing a reload — and would still look like a working feature to
   * whoever tested the direction that happened to be covered.
   */
  it.each([[true], [false]])(
    'reports the change once the server has accepted it (signPosts: %s)',
    async (value) => {
      mockPut.mockResolvedValue({ data: { channel: { signPosts: value } } });

      await channelAccountService.setSignPosts(CHANNEL, value);

      // Named by the CHANNEL, never by the operator: the writers list this scopes
      // is keyed on the account whose setting moved.
      expect(mockNoteBylineChanged).toHaveBeenCalledTimes(1);
      expect(mockNoteBylineChanged).toHaveBeenCalledWith(CHANNEL);
    },
  );

  it('reports nothing when the server refuses the write', async () => {
    mockPut.mockRejectedValue(new Error('network'));

    await expect(channelAccountService.setSignPosts(CHANNEL, true)).rejects.toThrow();

    // A refused toggle leaves every surface exactly as the caches already have it,
    // and throwing away a feed for a change that did not land is pure cost.
    expect(mockNoteBylineChanged).not.toHaveBeenCalled();
  });
});
