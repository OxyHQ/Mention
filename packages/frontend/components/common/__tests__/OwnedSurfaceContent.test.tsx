import TestRenderer, { act } from 'react-test-renderer';
import { OwnedSurfaceContent } from '../OwnedSurfaceContent';

it('removes only the content whose owner aborts', async () => {
  const first = new AbortController();
  const second = new AbortController();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <>
        <OwnedSurfaceContent signal={first.signal}>first</OwnedSurfaceContent>
        <OwnedSurfaceContent signal={second.signal}>second</OwnedSurfaceContent>
      </>,
    );
  });
  expect(renderer.toJSON()).toEqual(['first', 'second']);
  await act(async () => first.abort());
  expect(renderer.toJSON()).toBe('second');
  expect(second.signal.aborted).toBe(false);
  await act(async () => renderer.unmount());
});
