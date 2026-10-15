import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useSupervisionState } from '../useSupervisionState';

const mockAuth = {
  user: { id: 'person', kind: 'personal' },
  canUsePrivateApi: true,
  isAuthResolved: true,
};
const mockQuery: { data?: { self: null | { status: string } }; isSuccess: boolean } = {
  data: undefined,
  isSuccess: true,
};
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@oxy.so/services/ui', () => ({ useSupervision: () => mockQuery }));
let renderer: ReactTestRenderer;
let result: ReturnType<typeof useSupervisionState>;
function Probe() {
  result = useSupervisionState();
  return null;
}
beforeEach(() => {
  mockAuth.user = { id: 'person', kind: 'personal' };
  mockAuth.canUsePrivateApi = true;
  mockQuery.data = undefined;
});
afterEach(() => act(() => renderer?.unmount()));

it('does not treat retained success metadata without fresh shared data as an adult allowance', () => {
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(result.ready).toBe(false);
  mockQuery.data = { self: null };
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(true);
  expect(result.supervised).toBe(false);
  mockQuery.data = undefined;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(false);
});

it('uses the shared active/orphaned decision and withdraws presentation access on account transition', () => {
  mockQuery.data = { self: { status: 'orphaned' } };
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(result.supervised).toBe(true);
  mockAuth.canUsePrivateApi = false;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(false);
  mockAuth.canUsePrivateApi = true;
  mockAuth.user = { id: 'organization', kind: 'organization' };
  mockQuery.data = undefined;
  act(() => renderer.update(<Probe />));
  expect(result.ready).toBe(true);
  expect(result.supervised).toBe(false);
});
