const mockConfirm = jest.fn();
jest.mock('@oxy.so/bloom/surfaces', () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

import { confirmDialog } from '../alerts';

it('passes the owner’s cancellation signal to the shared confirmation', async () => {
  mockConfirm.mockResolvedValue(false);
  const controller = new AbortController();
  const onClosed = jest.fn();
  await expect(
    confirmDialog({ title: 'Confirm', signal: controller.signal, onClosed }),
  ).resolves.toBe(false);
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ signal: controller.signal, onClosed }),
  );
});
