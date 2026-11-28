import TestRenderer, { act } from 'react-test-renderer';
import { usePublicationContinuation } from '../usePublicationContinuation';

let mockEpoch = 1;
let mockRenderedUser: string | null = 'a';
let mockCurrentUser: string | null = 'a';
const mockServices = { http: { getSessionEpoch: () => mockEpoch } };
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: mockRenderedUser ? { id: mockRenderedUser } : null,
    oxyServices: mockServices,
  }),
  useAuthStore: {
    getState: () => ({ user: mockCurrentUser ? { id: mockCurrentUser } : null }),
  },
}));

beforeEach(() => {
  mockEpoch = 1;
  mockRenderedUser = 'a';
  mockCurrentUser = 'a';
});

it('drops an old UI continuation on epoch changes, ABA, or unmount', () => {
  let capture!: ReturnType<typeof usePublicationContinuation>['capture'];
  function Probe() {
    ({ capture } = usePublicationContinuation());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  const first = capture();
  if (!first) throw new Error('Missing continuation');
  expect(first()).toBe(true);
  mockEpoch++;
  mockCurrentUser = 'b';
  expect(first()).toBe(false);
  expect(capture()).toBeNull();
  mockCurrentUser = null;
  expect(first()).toBe(false);
  expect(capture()).toBeNull();
  mockEpoch++;
  mockCurrentUser = 'a';
  expect(first()).toBe(false);
  const next = capture();
  if (!next) throw new Error('Missing new continuation');
  expect(next()).toBe(true);
  act(() => renderer.unmount());
  expect(next()).toBe(false);
});

it('does not capture a continuation when rendered and projected viewers differ', () => {
  mockCurrentUser = 'b';
  let capture!: ReturnType<typeof usePublicationContinuation>['capture'];
  function Probe() {
    ({ capture } = usePublicationContinuation());
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  expect(capture()).toBeNull();
  act(() => renderer.unmount());
});
