import TestRenderer from 'react-test-renderer';
import { NotificationPermissionGate } from '../NotificationPermissionGate';

const mockStored = new Map<string, unknown>();
const mockOffer = jest.fn();
const mockRequest = jest.fn();
const mockDismiss = jest.fn();
let mockProps: { onLater(): void; onEnable(): Promise<void> };
let mockResolve: () => void;
const mockPresent = jest.fn((render) => {
  mockProps = render({ dismiss: mockDismiss }).props;
  return new Promise<void>((resolve) => {
    mockResolve = resolve;
  });
});
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('@/utils/sheet', () => ({ presentSheet: (...args: unknown[]) => mockPresent(...args) }));
jest.mock('@/components/NotificationPermissionSheet', () => ({
  NotificationPermissionSheet: () => null,
}));
jest.mock('@/utils/notifications', () => ({
  canOfferNotificationPermission: () => mockOffer(),
  requestNotificationPermissions: () => mockRequest(),
}));
jest.mock('@/utils/storage', () => ({
  Storage: {
    get: async (key: string) => mockStored.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      mockStored.set(key, value);
      return true;
    },
  },
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn() } }));
let roots: TestRenderer.ReactTestRenderer[];
async function mount() {
  let root!: TestRenderer.ReactTestRenderer;
  await TestRenderer.act(async () => {
    root = TestRenderer.create(<NotificationPermissionGate appIsReady />);
  });
  roots.push(root);
  return root;
}
async function advance() {
  await TestRenderer.act(async () => {
    jest.advanceTimersByTime(500);
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockStored.clear();
  roots = [];
  mockOffer.mockResolvedValue(true);
  mockRequest.mockResolvedValue(false);
  mockDismiss.mockImplementation(() => mockResolve?.());
});
afterEach(async () => {
  await TestRenderer.act(async () => {
    for (const root of roots) root.unmount();
    mockResolve?.();
  });
  jest.useRealTimers();
});
it('remembers Later across remounts and only presents one concurrent prompt', async () => {
  await mount();
  await mount();
  await advance();
  expect(mockPresent).toHaveBeenCalledTimes(1);
  await TestRenderer.act(async () => {
    mockProps.onLater();
  });
  await mount();
  await advance();
  expect(mockPresent).toHaveBeenCalledTimes(1);
});
it('does not educate an account whose OS permission was already decided', async () => {
  mockOffer.mockResolvedValue(false);
  await mount();
  await advance();
  expect(mockPresent).not.toHaveBeenCalled();
});
it('does not present after unmount while the permission query is pending', async () => {
  let resolve!: (value: boolean) => void;
  mockOffer.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const root = await mount();
  await advance();
  await TestRenderer.act(async () => {
    root.unmount();
  });
  await TestRenderer.act(async () => {
    resolve(true);
  });
  expect(mockPresent).not.toHaveBeenCalled();
  expect(mockStored.size).toBe(0);
});
it('dismisses on unmount, and suppresses repeated enable taps and later starts after OS denial', async () => {
  let resolve!: (value: boolean) => void;
  mockRequest.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const root = await mount();
  await advance();
  await TestRenderer.act(async () => {
    void mockProps.onEnable();
    void mockProps.onEnable();
  });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await TestRenderer.act(async () => {
    root.unmount();
    resolve(false);
  });
  expect(mockDismiss).toHaveBeenCalled();
  await mount();
  await advance();
  expect(mockPresent).toHaveBeenCalledTimes(1);
});
