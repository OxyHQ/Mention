import { present, presentCancelable } from '@oxy.so/bloom/surfaces';

import { presentCancelableSheet, presentSheet } from '../sheet';

jest.mock('@oxy.so/bloom/surfaces', () => ({
  present: jest.fn(() => Promise.resolve('done')),
  presentCancelable: jest.fn(() => Promise.resolve(undefined)),
}));

describe('presentSheet', () => {
  it('presents with no surface padding unless the caller sets its own', async () => {
    const render = () => null;

    await expect(presentSheet(render, { label: 'Sources' })).resolves.toBe('done');
    presentSheet(render, { contentPadding: 16 });

    expect(jest.mocked(present).mock.calls).toEqual([
      [render, { contentPadding: 0, label: 'Sources' }],
      [render, { contentPadding: 16 }],
    ]);
  });
});

it('passes cancellation and physical-closure ownership to Bloom', async () => {
  const render = () => null;
  const signal = new AbortController().signal;
  const onClosed = jest.fn();
  await presentCancelableSheet(render, { label: 'Owned', signal, onClosed });
  expect(presentCancelable).toHaveBeenCalledWith(render, {
    contentPadding: 0,
    label: 'Owned',
    signal,
    onClosed,
  });
});
