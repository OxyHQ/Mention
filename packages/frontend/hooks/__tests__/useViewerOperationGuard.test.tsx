import TestRenderer, { act } from 'react-test-renderer';
import { useViewerOperationGuard } from '../useViewerOperationGuard';

let mockEpoch = 0;
const mockViewerId = 'a';
let mockBearerId: string | null = 'a';
let mockCanUsePrivateApi = true;
let mockHasBearer = true;
let mockDeviceOwner: string | null = 'a';
let mockHasDeviceState = true;
let mockSessionMode: 'account' | 'identity' = 'account';
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    sessionMode: mockSessionMode,
    sessionClient: {
      getState: () => (mockHasDeviceState ? { activeAccountId: mockDeviceOwner } : null),
    },
  }),
  useAuth: () => ({
    user: { id: mockViewerId },
    canUsePrivateApi: mockCanUsePrivateApi,
    sessionMode: mockSessionMode,
    sessionClient: {
      getState: () => (mockHasDeviceState ? { activeAccountId: mockDeviceOwner } : null),
    },
    oxyServices: {
      http: { getSessionEpoch: () => mockEpoch },
      session: {
        get isAuthenticated() {
          return mockHasBearer;
        },
        get userId() {
          return mockBearerId;
        },
      },
    },
  }),
}));

it('captures each operation, checks the bearer, and invalidates old screens', () => {
  let capture!: ReturnType<typeof useViewerOperationGuard>['captureOwner'];
  function Probe() {
    ({ captureOwner: capture } = useViewerOperationGuard());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  const first = capture();
  if (!first) throw new Error('Expected first operation');
  expect(first()).toBe(true);
  mockEpoch += 1;
  expect(first()).toBe(false);
  // A new operation under the same viewer works after a session epoch change.
  const second = capture();
  if (!second) throw new Error('Expected second operation');
  expect(second()).toBe(true);
  // The bearer switches before React projects B. No A operation may start.
  mockBearerId = 'b';
  mockEpoch += 1;
  expect(second()).toBe(false);
  expect(capture()).toBeNull();
  // A → B → A does not revive either old operation.
  mockBearerId = 'a';
  mockEpoch += 1;
  expect(first()).toBe(false);
  expect(second()).toBe(false);
  const third = capture();
  if (!third) throw new Error('Expected third operation');
  expect(third()).toBe(true);
  mockCanUsePrivateApi = false;
  act(() => renderer.update(<Probe />));
  expect(capture()).toBeNull();
  act(() => renderer.unmount());
  expect(third()).toBe(false);
});

it('accepts a valid opaque OAuth bearer without a device projection, but rejects logout and a known different device owner', () => {
  mockEpoch = 0;
  mockBearerId = null;
  mockHasBearer = true;
  mockCanUsePrivateApi = true;
  mockHasDeviceState = false;
  let capture!: ReturnType<typeof useViewerOperationGuard>['captureOwner'];
  function Probe() {
    ({ captureOwner: capture } = useViewerOperationGuard());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  const oauthOperation = capture();
  if (!oauthOperation) throw new Error('Expected valid opaque OAuth operation');
  expect(oauthOperation()).toBe(true);
  mockHasDeviceState = true;
  mockDeviceOwner = 'b';
  expect(oauthOperation()).toBe(false);
  expect(capture()).toBeNull();
  mockHasDeviceState = false;
  mockHasBearer = false;
  expect(oauthOperation()).toBe(false);
  expect(capture()).toBeNull();
  act(() => renderer.unmount());
});

it('does not mistake another active device account for an identity-pinned session', () => {
  mockSessionMode = 'identity';
  mockEpoch = 0;
  mockCanUsePrivateApi = true;
  mockHasBearer = true;
  mockBearerId = 'a';
  mockHasDeviceState = true;
  mockDeviceOwner = 'b';
  let capture!: ReturnType<typeof useViewerOperationGuard>['captureOwner'];
  function Probe() {
    ({ captureOwner: capture } = useViewerOperationGuard());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(capture()).not.toBeNull();
  act(() => renderer.unmount());
  mockSessionMode = 'account';
});
