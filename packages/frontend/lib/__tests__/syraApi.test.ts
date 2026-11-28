/** Room UI uses the shared session client and preserves unavailable/invalid responses. */
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockPut = jest.fn();
const mockLinked = jest.fn((_options: unknown) => ({
  client: { get: mockGet, post: mockPost, put: mockPut },
}));
jest.mock('@/config', () => ({ SYRA_API_URL: 'https://api.syra.fm/api' }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { createLinkedClient: (options: unknown) => mockLinked(options) },
}));
jest.mock('@oxy.so/core/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));
const {
  roomsService,
  getLiveRooms,
  getLiveUsers,
  getLivePresencePreference,
  updateLivePresencePreference,
}: typeof import('../syraApi') = require('../syraApi');

const room = { _id: 'room', title: 'Discussion', host: 'host', status: 'live' };
beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockPut.mockReset();
});
it('constructs the shared client at the Syra API boundary', () => {
  expect(mockLinked).toHaveBeenCalledWith({ baseURL: 'https://api.syra.fm/api' });
});
it.each(['rooms', 'data', 'direct'])(
  'reads the %s envelope and rejects malformed rooms',
  async (shape) => {
    const rows = [room, null, { ...room, status: 'invalid' }, { ...room, host: 12 }];
    mockGet.mockResolvedValue(shape === 'direct' ? rows : { [shape]: rows });
    expect(await getLiveRooms()).toEqual([
      { ...room, type: 'talk', participants: [], speakers: [] },
    ]);
    expect(mockGet).toHaveBeenCalledWith('/rooms', { params: { status: 'live' } });
  },
);
it('preserves stage/broadcast types and filters invalid participant identifiers', async () => {
  mockGet.mockResolvedValue({
    rooms: ['stage', 'broadcast'].map((type) => ({
      ...room,
      type,
      participants: ['person', null],
      speakers: ['speaker', 42],
    })),
  });
  expect(await roomsService.getRooms()).toEqual(
    ['stage', 'broadcast'].map((type) => ({
      ...room,
      type,
      participants: ['person'],
      speakers: ['speaker'],
    })),
  );
  expect(mockGet).toHaveBeenCalledWith('/rooms', { params: undefined });
});
it.each([null, {}, { rooms: 'bad' }])('handles non-list response %j', async (value) => {
  mockGet.mockResolvedValue(value);
  expect(await getLiveRooms()).toEqual([]);
});
it('does not invent rooms when the session request fails', async () => {
  mockGet.mockRejectedValue(new Error('session changed'));
  expect(await getLiveRooms()).toEqual([]);
  expect(await roomsService.getRoom('room')).toBeNull();
});
it.each(['room', 'data', 'direct'])('reads one room from %s', async (shape) => {
  mockGet.mockResolvedValue(shape === 'direct' ? room : { [shape]: room });
  expect(await roomsService.getRoom('room')).toMatchObject(room);
  expect(mockGet).toHaveBeenCalledWith('/rooms/room');
});
it('does not issue room commands without an identifier', async () => {
  expect(await roomsService.getRoom('')).toBeNull();
  expect(await roomsService.startRoom('')).toBe(false);
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});
it.each(['startRoom', 'endRoom', 'leaveRoom'] as const)(
  'reports actual command success/failure for %s',
  async (method) => {
    expect(await roomsService[method]('room')).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(`/rooms/room/${method.replace('Room', '')}`);
    mockPost.mockRejectedValue(new Error('forbidden'));
    expect(await roomsService[method]('room')).toBe(false);
  },
);
it('uses presence responses without adding requester headers or defaults over server values', async () => {
  mockGet.mockResolvedValueOnce({ liveUsers: [{ userId: 'person', roomId: 'room' }] });
  expect(await getLiveUsers()).toEqual([{ userId: 'person', roomId: 'room' }]);
  mockGet.mockResolvedValueOnce({});
  expect(await getLiveUsers()).toEqual([]);
  mockGet.mockResolvedValueOnce({ liveVisibility: 'speaking' });
  expect(await getLivePresencePreference()).toBe('speaking');
  mockPut.mockResolvedValueOnce({ liveVisibility: 'active' });
  expect(await updateLivePresencePreference('speaking')).toBe('active');
  mockPut.mockResolvedValueOnce({});
  expect(await updateLivePresencePreference('speaking')).toBe('speaking');
  expect(mockPut).toHaveBeenCalledWith('/rooms/me/presence-preference', {
    liveVisibility: 'speaking',
  });
});
