import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { VideoViewabilityProvider } from '@/context/VideoPlaybackContext';
import { useReferenceVisibility } from '../useReferenceVisibility';

jest.mock('expo-router', () => ({ useIsFocused: jest.fn(() => true) }));
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

it('uses measured native feed viewability, gates focus, and never treats render-ahead as visible', () => {
  AppState.currentState = 'active';
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
  jest.mocked(useIsFocused).mockReturnValue(false);
  act(() => {
    renderer.update(<Feed keys={['two']} />);
  });
  expect(visible.get('two')).toBe(false);
  act(() => {
    renderer.unmount();
  });
});
