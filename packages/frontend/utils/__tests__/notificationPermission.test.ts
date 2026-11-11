import { notificationPermission } from '../notifications';

const mockGet = jest.fn();
const mockRequest = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockGet(),
  requestPermissionsAsync: () => mockRequest(),
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn() } }));

describe('notificationPermission', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports the OS status', async () => {
    mockGet.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    await expect(notificationPermission.getStatus()).resolves.toBe('undetermined');
    mockGet.mockResolvedValue({ status: 'granted', canAskAgain: true });
    await expect(notificationPermission.getStatus()).resolves.toBe('granted');
  });

  it('reads an undetermined permission that cannot be asked again as denied', async () => {
    mockGet.mockResolvedValue({ status: 'undetermined', canAskAgain: false });
    await expect(notificationPermission.getStatus()).resolves.toBe('denied');
  });

  it('requests the permission and returns the OS answer', async () => {
    mockRequest.mockResolvedValue({ status: 'granted' });
    await expect(notificationPermission.request()).resolves.toBe('granted');
  });
});
