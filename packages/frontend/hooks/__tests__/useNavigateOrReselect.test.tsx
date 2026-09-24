import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const mockNavigate = jest.fn();
const mockReselect = jest.fn();
let mockPathname = '/';

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ navigate: mockNavigate }),
}));
jest.mock('@/context/ScreenReselectContext', () => ({ useReselect: () => mockReselect }));

// eslint-disable-next-line import/first -- the mocks above must be installed first.
import { isCurrentRoute, useNavigateOrReselect } from '../useNavigateOrReselect';

describe('isCurrentRoute', () => {
  it('matches the page the reader is on', () => {
    expect(isCurrentRoute('/', '/')).toBe(true);
    expect(isCurrentRoute('/@nate', '/@nate')).toBe(true);
  });
  it('treats a page below a section as somewhere else', () => {
    expect(isCurrentRoute('/@nate', '/@nate/replies')).toBe(false);
    expect(isCurrentRoute('/', '/explore')).toBe(false);
  });
  it('does not guess about an object href', () => {
    expect(isCurrentRoute({ pathname: '/' }, '/')).toBe(false);
  });
});

describe('useNavigateOrReselect', () => {
  let go!: ReturnType<typeof useNavigateOrReselect>;
  function Probe() {
    go = useNavigateOrReselect();
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    act(() => { TestRenderer.create(<Probe />); });
  });

  it('reselects the current page instead of navigating to it', () => {
    act(() => go('/'));
    expect(mockReselect).toHaveBeenCalledTimes(1);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('navigates anywhere else', () => {
    act(() => go('/explore'));
    expect(mockNavigate).toHaveBeenCalledWith('/explore');
    expect(mockReselect).not.toHaveBeenCalled();
  });
});
