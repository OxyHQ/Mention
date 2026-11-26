import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useSupervisionState } from '../useSupervisionState';

const mockAuth = {
  user: { id: 'person', kind: 'personal' },
  canUsePrivateApi: true,
  isAuthResolved: true,
};
/** `useSupervision()`'s Services 15 `RecordView`: `value`, `status`, `refresh`. */
const mockQuery: {
  value?: { self: null | { status: string } };
  status: 'idle' | 'loading' | 'success' | 'error';
  refresh: jest.Mock;
} = {
  value: undefined,
  status: 'success',
  refresh: jest.fn(),
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuth,
  useSupervision: () => mockQuery,
}));
let renderer: ReactTestRenderer;
let result: ReturnType<typeof useSupervisionState>;
function Probe() {
  result = useSupervisionState();
  return null;
}
beforeEach(() => {
  mockAuth.user = { id: 'person', kind: 'personal' };
  mockAuth.canUsePrivateApi = true;
  mockQuery.value = undefined;
  mockQuery.status = 'success';
});
afterEach(() => act(() => renderer?.unmount()));

it('does not treat retained success metadata without fresh shared data as an adult allowance', () => {
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(result.ready).toBe(false);
  mockQuery.value = { self: null };
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(true);
  expect(result.supervised).toBe(false);
  mockQuery.value = undefined;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(false);
});

it('uses the shared active/orphaned decision and withdraws presentation access on account transition', () => {
  mockQuery.value = { self: { status: 'orphaned' } };
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(result.supervised).toBe(true);
  mockAuth.canUsePrivateApi = false;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(false);
  mockAuth.canUsePrivateApi = true;
  mockAuth.user = { id: 'organization', kind: 'organization' };
  mockQuery.value = undefined;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(true);
  expect(result.supervised).toBe(false);
});

it("reports a failed read as isError and keeps the read's refresh", () => {
  mockQuery.status = 'error';
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(result.isError).toBe(true);
  expect(result.ready).toBe(false);
  result.refresh();
  expect(mockQuery.refresh).toHaveBeenCalledTimes(1);
  mockQuery.status = 'success';
  act(() => renderer.update(<Probe />));
  expect(result.isError).toBe(false);
});
