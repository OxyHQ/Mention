import TestRenderer, { act } from 'react-test-renderer';
import { useOwnerVirtualizer } from '../useOwnerVirtualizer.web';

let mockOwner: { current: HTMLElement | null } | null = null;
const mockWindowVirtualizer = jest.fn();
const mockElementVirtualizer = jest.fn();
jest.mock('@oxy.so/bloom/app-shell/hooks', () => ({
  usePanelScrollContainer: () => mockOwner,
}));
jest.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (options: unknown) => mockWindowVirtualizer(options),
  useVirtualizer: (options: unknown) => mockElementVirtualizer(options),
}));

it('hands virtualization to the panel owner and back to the document when the screen moves', () => {
  const documentList = { owner: 'document' };
  const panelList = { owner: 'panel' };
  mockWindowVirtualizer.mockReturnValue(documentList);
  mockElementVirtualizer.mockReturnValue(panelList);
  const options = { count: 50, estimateSize: () => 200, overscan: 3 };
  let selected: unknown;
  function Harness() {
    selected = useOwnerVirtualizer(options);
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<Harness />);
  });
  expect(selected).toBe(documentList);
  expect(mockWindowVirtualizer).toHaveBeenLastCalledWith({ ...options, enabled: true });
  expect(mockElementVirtualizer.mock.lastCall?.[0].enabled).toBe(false);
  expect(mockElementVirtualizer.mock.lastCall?.[0].getScrollElement()).toBeNull();

  const element = {} as HTMLElement;
  mockOwner = { current: element };
  act(() => {
    tree.update(<Harness />);
  });
  expect(selected).toBe(panelList);
  expect(mockWindowVirtualizer).toHaveBeenLastCalledWith({ ...options, enabled: false });
  expect(mockElementVirtualizer.mock.lastCall?.[0].enabled).toBe(true);
  expect(mockElementVirtualizer.mock.lastCall?.[0].getScrollElement()).toBe(element);

  mockOwner = null;
  act(() => {
    tree.update(<Harness />);
  });
  expect(selected).toBe(documentList);
  expect(mockElementVirtualizer.mock.lastCall?.[0].enabled).toBe(false);
  act(() => {
    tree.unmount();
  });
});
