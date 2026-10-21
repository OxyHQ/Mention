import TestRenderer, { act } from 'react-test-renderer';
import { CommunitiesPreviewGate, useCommunitiesPreview } from '../useCommunitiesPreview';

let mockUsername: string | undefined;
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockUsername ? { username: mockUsername } : undefined }),
}));
jest.mock('@/components/NotFoundScreen', () => () => 'not-found');

function render(element: React.ReactElement): string {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return JSON.stringify(renderer.toJSON());
}

describe('communities preview', () => {
  it('is on for the preview accounts only, and off when signed out', () => {
    const verdict = (username?: string) => {
      mockUsername = username;
      let result = false;
      function Probe() {
        result = useCommunitiesPreview();
        return null;
      }
      render(<Probe />);
      return result;
    };
    expect(verdict('nate')).toBe(true);
    expect(verdict('oxy')).toBe(true);
    expect(verdict('ada')).toBe(false);
    expect(verdict(undefined)).toBe(false);
  });

  it('gates a page: the page itself inside the preview, the page that does not exist outside', () => {
    mockUsername = 'nate';
    expect(render(<CommunitiesPreviewGate>communities-page</CommunitiesPreviewGate>)).toContain(
      'communities-page',
    );
    mockUsername = 'ada';
    expect(render(<CommunitiesPreviewGate>communities-page</CommunitiesPreviewGate>)).toBe(
      '"not-found"',
    );
  });
});
