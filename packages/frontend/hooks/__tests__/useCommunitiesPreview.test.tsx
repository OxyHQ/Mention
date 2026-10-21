import TestRenderer, { act } from 'react-test-renderer';
import { useCommunitiesPreview } from '../useCommunitiesPreview';

let mockUsername: string | undefined;
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockUsername ? { username: mockUsername } : undefined }),
}));

function verdict(username?: string): boolean {
  mockUsername = username;
  let result = false;
  function Probe() {
    result = useCommunitiesPreview();
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  return result;
}

describe('useCommunitiesPreview', () => {
  it('is on for the preview accounts only, and off when signed out', () => {
    expect(verdict('nate')).toBe(true);
    expect(verdict('oxy')).toBe(true);
    expect(verdict('ada')).toBe(false);
    expect(verdict(undefined)).toBe(false);
  });
});
