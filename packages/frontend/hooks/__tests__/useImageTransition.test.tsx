import { act, create } from 'react-test-renderer';
import { useImageTransition } from '../useImageTransition';

let mockReduced = false;
jest.mock('@oxy.so/bloom/hooks', () => ({ usePrefersReducedMotion: () => mockReduced }));

it('drops the cross-fade for a viewer who asked for less motion', () => {
  let value = -1;
  function Probe() {
    value = useImageTransition(150);
    return null;
  }
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<Probe />);
  });
  expect(value).toBe(150);
  mockReduced = true;
  act(() => tree.update(<Probe />));
  expect(value).toBe(0);
  act(() => tree.unmount());
});
