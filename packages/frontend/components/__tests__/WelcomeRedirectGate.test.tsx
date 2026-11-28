import TestRenderer, { act } from 'react-test-renderer';

const mockRedirect = jest.fn((_props: { href: unknown }) => null);
let mockPathname = '/';
let mockNeedsWelcome = false;

jest.mock('expo-router', () => ({
  Redirect: (props: { href: unknown }) => mockRedirect(props),
  usePathname: () => mockPathname,
}));
jest.mock('@/hooks/useWelcome', () => ({
  useWelcomeStatus: () => ({ needsWelcome: mockNeedsWelcome }),
}));

import { WelcomeRedirectGate } from '@/components/WelcomeRedirectGate';

function renderAt(pathname: string, needsWelcome: boolean) {
  mockPathname = pathname;
  mockNeedsWelcome = needsWelcome;
  mockRedirect.mockClear();
  act(() => {
    TestRenderer.create(<WelcomeRedirectGate />);
  });
  return mockRedirect.mock.calls.map(([props]) => props.href);
}

describe('WelcomeRedirectGate', () => {
  it('sends an unfinished account to /welcome, remembering where it was going', () => {
    expect(renderAt('/', true)).toEqual([{ pathname: '/welcome', params: {} }]);
    expect(renderAt('/p/123', true)).toEqual([
      { pathname: '/welcome', params: { next: '/p/123' } },
    ]);
  });

  it('stays out of the way once the flow is done, and on /welcome itself', () => {
    expect(renderAt('/', false)).toEqual([]);
    expect(renderAt('/welcome', true)).toEqual([]);
  });
});
