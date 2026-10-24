import TestRenderer, { act } from 'react-test-renderer';
import { VideoViewabilityProvider } from '@/context/VideoPlaybackContext';
import { useReferenceVisibility } from '../useReferenceVisibility';

let mockScreenVisible = true;
jest.mock('@oxy.so/bloom/screen', () => ({ useScreenVisible: () => mockScreenVisible }));
const visible = new Map<string, boolean>();
function Card({ id }: { id: string }) {
  visible.set(id, useReferenceVisibility(id).visible);
  return null;
}
function Feed({ keys }: { keys: string[] }) {
  return (
    <VideoViewabilityProvider viewableKeys={new Set(keys)}>
      <Card id="one" />
      <Card id="two" />
    </VideoViewabilityProvider>
  );
}

it('uses measured native feed viewability, gates on the screen being visible, and never treats render-ahead as visible', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Feed keys={['one']} />);
  });
  expect(visible.get('one')).toBe(true);
  expect(visible.get('two')).toBe(false);
  act(() => {
    renderer.update(<Feed keys={['two']} />);
  });
  expect(visible.get('one')).toBe(false);
  expect(visible.get('two')).toBe(true);
  mockScreenVisible = false;
  act(() => {
    renderer.update(<Feed keys={['two']} />);
  });
  expect(visible.get('two')).toBe(false);
  act(() => {
    renderer.unmount();
  });
});
