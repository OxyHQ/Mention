import { present } from '@oxy.so/bloom/surfaces';

import { presentSheet } from '../sheet';

jest.mock('@oxy.so/bloom/surfaces', () => ({ present: jest.fn(() => Promise.resolve('done')) }));

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
