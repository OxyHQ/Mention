const mockDismiss = jest.fn();
const mockPresentSheet = jest.fn((render: (surface: { dismiss: () => void }) => unknown) => {
  render({ dismiss: mockDismiss });
  return new Promise(() => {});
});
const mockPresentCancelableSheet = jest.fn();
jest.mock('@/utils/sheet', () => ({
  presentSheet: (render: (surface: { dismiss: () => void }) => unknown) => mockPresentSheet(render),
  presentCancelableSheet: (...args: unknown[]) => mockPresentCancelableSheet(...args),
}));
jest.mock('@oxy.so/bloom/grouped-section', () => ({
  GroupedSection: () => null,
  GroupedSectionItem: () => null,
}));
import { showActionMenu, showCancelableActionMenu } from '../ActionMenu';

it('does not dismiss an existing menu when the new owner is already cancelled', async () => {
  void showActionMenu({ label: 'Existing', groups: [] });
  const owner = new AbortController();
  owner.abort();
  const onClosed = jest.fn();
  await showCancelableActionMenu({ label: 'Stale', groups: [], signal: owner.signal, onClosed });
  expect(onClosed).toHaveBeenCalledTimes(1);
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockPresentCancelableSheet).not.toHaveBeenCalled();
});
